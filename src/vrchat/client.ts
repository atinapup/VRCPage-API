/*
 * The one place vrc.page talks to VRChat.
 *
 * VRChat has no public API and asks that nobody query it more than once a
 * minute. A flagged service account stops the whole product, so this client
 * is built to be conservative before it is built to be fast. Spec section 2
 * lists the rules; this file is where each one lives:
 *
 *   one at a time    every read takes a slot by locking the single
 *                    vrchat.client_state row. Only one slot exists per
 *                    minimum interval, so two reads can never be in flight,
 *                    across every request and every API process.
 *   60s spacing      taking the slot pushes next_call_at forward before the
 *                    call goes out, not after, so a slow call cannot let a
 *                    second one through behind it.
 *   daily budget     each lane has a share of budget.daily_calls, counted
 *                    from vrchat.api_calls since midnight UTC. A lane that
 *                    runs dry waits; it never borrows from another.
 *   backoff          a 429 sets a site-wide wait, starting at five minutes
 *                    and doubling to six hours, with jitter.
 *   circuit breaker  three refusals in a row, of the session or of a sign-in,
 *                    pause everything and say so in the log. Restarting, or
 *                    clearing circuit_opened_at by hand, starts it again.
 *   logged           every read, with its lane, status and outcome. Sign-ins
 *                    are not reads and spend no budget; they go to the log.
 *
 * Nothing here blocks: a read that cannot have the slot says so and says for
 * how long. Waiting a minute inside somebody's request would only move the
 * queue into their browser.
 *
 * The session. The client signs in as the spare account in the environment,
 * with its password and an authenticator code from its TOTP secret, and keeps
 * the cookie in vrchat.client_state. VRChat limits how many sessions one
 * account opens, so it signs in only when there is no cookie there: at first,
 * and after VRChat refuses the one it had. The sign-in takes the read's slot
 * and the read follows it, so the only burst is once per session.
 */
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { AppConfig } from '../config/app-config.js';
import { Database } from '../database/database.js';
import type { DB, VrchatCallOutcome, VrchatEndpoint, VrchatLane } from '../database/database.types.js';
import { ENDPOINTS, readGroup, readProfile, VRCHAT_BASE_URL } from './api.js';
import { nextBackoff, untilMidnightUtc } from './budget.js';
import { totp } from './totp.js';
import type { Lane, ReadResult, VRChatGroup, VRChatUser } from './types.js';

/** How long to wait for VRChat before giving up on one call. */
const TIMEOUT_MS = 15_000;

/** What a refusal reports when the wait isn't a number we know. */
const A_WHILE = 3600;

type Settings = {
  enabled: boolean;
  minIntervalSeconds: number;
  backoffInitialSeconds: number;
  backoffMaxSeconds: number;
  userAgent: string;
  circuitBreakerThreshold: number;
};

type Slot = { ok: true; startedAt: Date; session: string | null } | { ok: false; waitSeconds: number; why: string };

/** One row of vrchat.api_calls, as this client writes it. */
type CallRecord = {
  startedAt: Date;
  durationMs: number;
  lane: VrchatLane;
  jobId: string | null;
  endpoint: VrchatEndpoint;
  targetId: string;
  httpStatus: number | null;
  outcome: VrchatCallOutcome;
  retryAfterSeconds: number | null;
  error: string | null;
};

/** What came back from one HTTP call, before it means anything. */
type Answer = {
  status: number | null;
  outcome: VrchatCallOutcome;
  body: unknown;
  retryAfterSeconds: number | null;
  error: string | null;
  /** The `auth` cookie VRChat set, which only a sign-in does. */
  authCookie?: string;
};

/** What to send besides the user agent. A body makes it a POST. */
type Send = { session?: string; authorization?: string; json?: unknown };

function seconds(from: Date, to: Date | null): number {
  return to ? Math.max(0, Math.ceil((to.getTime() - from.getTime()) / 1000)) : 0;
}

@Injectable()
export class VRChatClient implements OnApplicationBootstrap {
  private readonly logger = new Logger(VRChatClient.name);

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  /** Whether there is an account to call with at all. */
  get configured(): boolean {
    return this.config.vrchat.account !== null;
  }

  /**
   * A restart is the operator's answer to a refused session, so it is also
   * what closes the circuit: the account in the environment may be fixed.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.configured) {
      this.logger.warn('No VRCHAT_USERNAME, VRCHAT_PASSWORD and VRCHAT_TOTP_SECRET: nothing is read from VRChat.');
      return;
    }
    const state = await this.db.selectFrom('vrchat.clientState').select(['circuitOpenedAt', 'circuitReason']).executeTakeFirst();
    if (!state?.circuitOpenedAt) return;
    await this.db.write({ requestId: randomUUID(), type: 'system', accountId: null }, (trx) =>
      trx.updateTable('vrchat.clientState').set({ circuitOpenedAt: null, circuitReason: null, consecutiveAuthFailures: 0 }).execute(),
    );
    this.logger.warn(`VRChat traffic was paused (${state.circuitReason ?? 'no reason recorded'}); starting it again with the session from the environment.`);
  }

  getUser(lane: Lane, id: string, jobId?: string): Promise<ReadResult<VRChatUser>> {
    return this.read(lane, 'get_user', id, jobId, (body) => readProfile(body, id));
  }

  getGroup(lane: Lane, id: string, jobId?: string): Promise<ReadResult<VRChatGroup>> {
    return this.read(lane, 'get_group', id, jobId, (body) => readGroup(body, id));
  }

  private async read<T>(lane: Lane, endpoint: VrchatEndpoint, id: string, jobId: string | undefined, parse: (body: unknown) => T | null): Promise<ReadResult<T>> {
    if (!this.configured) return { ok: false, reason: 'busy', waitSeconds: A_WHILE };

    const settings = await this.settings();
    const slot = await this.takeSlot(lane, settings);
    if (!slot.ok) {
      this.logger.debug(`${endpoint} ${id} not read: ${slot.why}`);
      return { ok: false, reason: 'busy', waitSeconds: slot.waitSeconds };
    }

    const session = slot.session ?? (await this.signIn(settings));
    if (!session) return { ok: false, reason: 'unavailable' };

    const path = endpoint === 'get_user' ? ENDPOINTS.user(id) : ENDPOINTS.group(id);
    const answer = await this.call(path, settings.userAgent, { session });
    const durationMs = Date.now() - slot.startedAt.getTime();

    // A 200 whose body we can no longer read is VRChat having changed shape.
    // It is recorded against the call, because that is where it will be found.
    const value = answer.outcome === 'ok' ? parse(answer.body) : null;
    const unreadable = answer.outcome === 'ok' && value === null;

    await this.record(
      {
        startedAt: slot.startedAt,
        durationMs,
        lane,
        jobId: jobId ?? null,
        endpoint,
        targetId: id.slice(0, 64),
        httpStatus: answer.status,
        outcome: answer.outcome,
        retryAfterSeconds: answer.retryAfterSeconds,
        error: unreadable ? `VRChat answered 200 with a body this client could not read.` : answer.error,
      },
      answer,
      settings,
    );

    if (value !== null) return { ok: true, value };
    if (answer.outcome === 'not_found') return { ok: false, reason: 'not_found' };
    if (answer.outcome === 'rate_limited') return { ok: false, reason: 'rate_limited', waitSeconds: answer.retryAfterSeconds ?? settings.backoffInitialSeconds };
    return { ok: false, reason: 'unavailable' };
  }

  /** Every tunable in one round trip, so the kill switch works without a restart. */
  private async settings(): Promise<Settings> {
    const { rows } = await sql<Settings>`
      SELECT internal.setting('vrchat.api.enabled')::boolean                      AS "enabled",
             internal.setting('vrchat.api.min_interval_seconds')::int             AS "minIntervalSeconds",
             internal.setting('vrchat.api.backoff_initial_seconds')::int          AS "backoffInitialSeconds",
             internal.setting('vrchat.api.backoff_max_seconds')::int              AS "backoffMaxSeconds",
             internal.setting('vrchat.api.user_agent') #>> '{}'                   AS "userAgent",
             internal.setting('vrchat.api.circuit_breaker_threshold')::int        AS "circuitBreakerThreshold"
    `.execute(this.db);
    return rows[0];
  }

  /**
   * Take the one slot, or say how long until there is one.
   *
   * Everything is decided inside a transaction holding a row lock on
   * vrchat.client_state, so two requests can't both decide it is their turn.
   * The slot is spent the moment it is taken: next_call_at moves forward
   * before the call leaves, and it stays moved whether the call works or not.
   */
  private takeSlot(lane: Lane, settings: Settings): Promise<Slot> {
    return this.db.write({ requestId: randomUUID(), type: 'system', accountId: null }, async (trx) => {
      const state = await trx
        .selectFrom('vrchat.clientState')
        .select(['nextCallAt', 'backoffUntil', 'circuitOpenedAt', 'circuitReason', 'authCookie'])
        .forUpdate()
        .executeTakeFirstOrThrow();

      const now = new Date();
      if (!settings.enabled) return { ok: false as const, waitSeconds: A_WHILE, why: 'VRChat reads are switched off (vrchat.api.enabled).' };
      if (state.circuitOpenedAt) return { ok: false as const, waitSeconds: A_WHILE, why: `VRChat traffic is paused: ${state.circuitReason ?? 'unknown'}.` };

      const backoff = seconds(now, state.backoffUntil);
      if (backoff > 0) return { ok: false as const, waitSeconds: backoff, why: `waiting out a rate limit for another ${backoff}s.` };

      const spacing = seconds(now, state.nextCallAt);
      if (spacing > 0) return { ok: false as const, waitSeconds: spacing, why: `another read has the slot for another ${spacing}s.` };

      const budget = await trx.selectFrom('vrchat.budgetToday').select(['callsUsed', 'callsAllowed']).where('lane', '=', lane).executeTakeFirst();
      // A lane with no cap at all is a lane that is switched off, not one
      // with no limit, so a missing number counts as none left.
      const used = budget?.callsUsed ?? 0;
      const allowed = budget?.callsAllowed ?? 0;
      if (used >= allowed) {
        return { ok: false as const, waitSeconds: untilMidnightUtc(now), why: `the ${lane} lane has used all ${allowed} of today's calls.` };
      }

      await trx
        .updateTable('vrchat.clientState')
        .set({ nextCallAt: new Date(now.getTime() + settings.minIntervalSeconds * 1000) })
        .execute();
      return { ok: true as const, startedAt: now, session: state.authCookie };
    });
  }

  /** One HTTP call. Never throws: everything that can go wrong becomes an outcome. */
  private async call(path: string, userAgent: string, send: Send): Promise<Answer> {
    let response: Response;
    try {
      response = await fetch(`${VRCHAT_BASE_URL}${path}`, {
        method: send.json === undefined ? 'GET' : 'POST',
        headers: {
          // VRChat asks to be told who is calling and how to reach them.
          'user-agent': userAgent,
          accept: 'application/json',
          ...(send.session ? { cookie: `auth=${send.session}` } : {}),
          ...(send.authorization ? { authorization: send.authorization } : {}),
          ...(send.json === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: send.json === undefined ? undefined : JSON.stringify(send.json),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return { status: null, outcome: timedOut ? 'timeout' : 'network_error', body: null, retryAfterSeconds: null, error: error instanceof Error ? error.message : String(error) };
    }

    const status = response.status;
    const retryAfter = Number(response.headers.get('retry-after'));
    const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null;

    if (status === 200) {
      const authCookie = response.headers
        .getSetCookie()
        .map((cookie) => /^auth=([^;]+)/.exec(cookie)?.[1])
        .find(Boolean);
      try {
        return { status, outcome: 'ok', body: await response.json(), retryAfterSeconds: null, error: null, authCookie };
      } catch (error) {
        return { status, outcome: 'ok', body: null, retryAfterSeconds: null, error: error instanceof Error ? error.message : String(error) };
      }
    }

    // The body of a failure is VRChat's own message, worth keeping and small.
    const detail = (await response.text().catch(() => '')).slice(0, 500) || response.statusText;
    if (status === 404) return { status, outcome: 'not_found', body: null, retryAfterSeconds, error: null };
    if (status === 429) return { status, outcome: 'rate_limited', body: null, retryAfterSeconds, error: detail };
    if (status === 401 || status === 403) return { status, outcome: 'auth_failed', body: null, retryAfterSeconds, error: detail };
    if (status >= 500) return { status, outcome: 'server_error', body: null, retryAfterSeconds, error: detail };
    return { status, outcome: 'server_error', body: null, retryAfterSeconds, error: detail };
  }

  /** Log the call, and move the client's state on from what it said. */
  private async record(call: CallRecord, answer: Answer, settings: Settings): Promise<void> {
    await this.db.write({ requestId: randomUUID(), type: 'system', accountId: null }, async (trx) => {
      await trx.insertInto('vrchat.apiCalls').values(call).execute();

      if (answer.outcome === 'rate_limited') return this.backOff(trx, answer, settings);
      if (answer.outcome === 'auth_failed') return this.authFailed(trx, settings, 'the session');
      // Anything else, including a 404, means the session still works and
      // VRChat is not pushing back, so both counts start again.
      await trx.updateTable('vrchat.clientState').set({ backoffSeconds: 0, backoffUntil: null, consecutiveAuthFailures: 0 }).execute();
    });
  }

  /**
   * A 429 stops every lane, not just this one: the limit is on the account,
   * and carrying on in another lane is exactly what gets an account flagged.
   */
  private async backOff(trx: Transaction<DB>, answer: Answer, settings: Settings): Promise<void> {
    const state = await trx.selectFrom('vrchat.clientState').select('backoffSeconds').forUpdate().executeTakeFirstOrThrow();
    const { keep, wait } = nextBackoff(state.backoffSeconds, settings.backoffInitialSeconds, settings.backoffMaxSeconds, answer.retryAfterSeconds);

    await trx
      .updateTable('vrchat.clientState')
      .set({ backoffSeconds: keep, backoffUntil: new Date(Date.now() + wait * 1000) })
      .execute();
    this.logger.warn(`VRChat rate-limited us. No reads at all for about ${Math.round(wait / 60)} minutes.`);
  }

  /**
   * A refusal, of the session or of a sign-in, drops the session so the next
   * read signs in again. Refusals in a row are the one failure that stops
   * everything until a person looks, because signing in again and again is
   * how an account gets locked.
   */
  private async authFailed(trx: Transaction<DB>, settings: Settings, what: string): Promise<void> {
    const state = await trx.selectFrom('vrchat.clientState').select('consecutiveAuthFailures').forUpdate().executeTakeFirstOrThrow();
    const failures = state.consecutiveAuthFailures + 1;
    const open = failures >= settings.circuitBreakerThreshold;
    const reason = `VRChat refused ${failures} times in a row, the last time ${what}.`.slice(0, 500);

    await trx
      .updateTable('vrchat.clientState')
      .set({
        authCookie: null,
        consecutiveAuthFailures: failures,
        ...(open ? { circuitOpenedAt: new Date(), circuitReason: reason } : {}),
      })
      .execute();

    if (open) {
      this.logger.error(
        `${reason} All VRChat reads are paused. Check VRCHAT_USERNAME, VRCHAT_PASSWORD and VRCHAT_TOTP_SECRET, ` +
          'and that the account still signs in at vrchat.com, then restart the API. Pages keep serving from the database meanwhile.',
      );
    } else {
      this.logger.warn(`VRChat refused ${what} (${failures} of ${settings.circuitBreakerThreshold} before reads are paused). The next read signs in again.`);
    }
  }

  /**
   * Sign the service account in and keep the session, or return null having
   * dealt with why not. The read that asked waits for this, inside its slot.
   */
  private async signIn(settings: Settings): Promise<string | null> {
    const account = this.config.vrchat.account;
    if (!account) return null;

    const basic = Buffer.from(`${encodeURIComponent(account.username)}:${encodeURIComponent(account.password)}`).toString('base64');
    const login = await this.call(ENDPOINTS.signIn, settings.userAgent, { authorization: `Basic ${basic}` });
    const session = login.authCookie;
    if (login.outcome !== 'ok' || !session) return this.signInFailed(login, settings, 'VRChat answered the sign-in without a session cookie.');

    // An account without 2FA is signed in already. One with it answers with
    // the kinds of code it takes, and only an authenticator code can be
    // given without a person.
    const kinds = (login.body as { requiresTwoFactorAuth?: unknown } | null)?.requiresTwoFactorAuth;
    if (Array.isArray(kinds)) {
      if (!kinds.includes('totp')) {
        return this.signInFailed(login, settings, `VRChat asks this account for ${kinds.join(' or ')}, not an authenticator code. Turn on authenticator-app 2FA for it.`);
      }
      const verify = await this.call(ENDPOINTS.verifyTotp, settings.userAgent, { session, json: { code: totp(account.totpSecret, Date.now()) } });
      if (verify.outcome !== 'ok' || (verify.body as { verified?: unknown } | null)?.verified !== true) {
        return this.signInFailed(verify, settings, 'VRChat did not accept the authenticator code.');
      }
    }

    await this.db.write({ requestId: randomUUID(), type: 'system', accountId: null }, (trx) =>
      trx.updateTable('vrchat.clientState').set({ authCookie: session }).execute(),
    );
    this.logger.log('Signed in to VRChat as the service account.');
    return session;
  }

  /**
   * A 429 backs off like any read's. A refusal counts towards the circuit
   * like a refused session, so a wrong password is tried a few times a minute
   * apart, not every minute for ever. VRChat being down is only logged: the
   * next read tries again. `why` explains a 200 that still wasn't a sign-in.
   */
  private async signInFailed(answer: Answer, settings: Settings, why: string): Promise<null> {
    const error = answer.outcome === 'ok' ? why : (answer.error ?? `HTTP ${answer.status}`);
    const refused = answer.status !== null && answer.status < 500 && answer.outcome !== 'rate_limited';

    if (answer.outcome === 'rate_limited') {
      await this.db.write({ requestId: randomUUID(), type: 'system', accountId: null }, (trx) => this.backOff(trx, answer, settings));
    } else if (refused) {
      await this.db.write({ requestId: randomUUID(), type: 'system', accountId: null }, (trx) => this.authFailed(trx, settings, `the sign-in: ${error}`));
    } else {
      this.logger.warn(`Could not sign in to VRChat (${answer.outcome}: ${error}). The next read tries again.`);
    }
    return null;
  }
}
