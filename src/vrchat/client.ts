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
 *   circuit breaker  three refused sessions in a row pauses everything and
 *                    says so in the log. Restarting with a good cookie, or
 *                    clearing circuit_opened_at by hand, starts it again.
 *   logged           every call, with its lane, status and outcome.
 *
 * Nothing here blocks: a read that cannot have the slot says so and says for
 * how long. Waiting a minute inside somebody's request would only move the
 * queue into their browser.
 *
 * vrc.page never holds a VRChat password. The client carries a session cookie
 * the operator obtained themselves and put in the environment.
 */
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { AppConfig } from '../config/app-config.js';
import { Database } from '../database/database.js';
import type { DB, VrchatCallOutcome, VrchatEndpoint, VrchatLane } from '../database/database.types.js';
import { ENDPOINTS, readGroup, readProfile, VRCHAT_BASE_URL } from './api.js';
import { nextBackoff, untilMidnightUtc } from './budget.js';
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

type Slot = { ok: true; startedAt: Date } | { ok: false; waitSeconds: number; why: string };

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
};

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

  /** Whether there is a session to call with at all. */
  get configured(): boolean {
    return this.config.vrchat.authCookie !== null;
  }

  /**
   * A restart is the operator's answer to a refused session, so it is also
   * what closes the circuit: the cookie in the environment may be a new one.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.configured) {
      this.logger.warn('No VRCHAT_AUTH_COOKIE: nothing is read from VRChat.');
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

    const path = endpoint === 'get_user' ? ENDPOINTS.user(id) : ENDPOINTS.group(id);
    const answer = await this.call(path, settings.userAgent);
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
        .select(['nextCallAt', 'backoffUntil', 'circuitOpenedAt', 'circuitReason'])
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
      return { ok: true as const, startedAt: now };
    });
  }

  /** One HTTP call. Never throws: everything that can go wrong becomes an outcome. */
  private async call(path: string, userAgent: string): Promise<Answer> {
    let response: Response;
    try {
      response = await fetch(`${VRCHAT_BASE_URL}${path}`, {
        headers: {
          // VRChat asks to be told who is calling and how to reach them.
          'user-agent': userAgent,
          accept: 'application/json',
          cookie: `auth=${this.config.vrchat.authCookie}`,
        },
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
      try {
        return { status, outcome: 'ok', body: await response.json(), retryAfterSeconds: null, error: null };
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
      if (answer.outcome === 'auth_failed') return this.authFailed(trx, settings);
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

  /** A refused session is the one failure that stops everything until a person looks. */
  private async authFailed(trx: Transaction<DB>, settings: Settings): Promise<void> {
    const state = await trx.selectFrom('vrchat.clientState').select('consecutiveAuthFailures').forUpdate().executeTakeFirstOrThrow();
    const failures = state.consecutiveAuthFailures + 1;
    const open = failures >= settings.circuitBreakerThreshold;

    await trx
      .updateTable('vrchat.clientState')
      .set({
        consecutiveAuthFailures: failures,
        ...(open ? { circuitOpenedAt: new Date(), circuitReason: `VRChat refused the session ${failures} times in a row.` } : {}),
      })
      .execute();

    if (open) {
      this.logger.error(
        `VRChat refused the session ${failures} times in a row, so all VRChat reads are paused. ` +
          'Get a new session cookie, put it in VRCHAT_AUTH_COOKIE, and restart the API. Pages keep serving from the database meanwhile.',
      );
    } else {
      this.logger.warn(`VRChat refused the session (${failures} of ${settings.circuitBreakerThreshold} before reads are paused).`);
    }
  }
}
