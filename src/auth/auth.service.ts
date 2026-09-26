import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import pg from 'pg';
import { Audit, type AuditEvent } from '../audit/audit.js';
import { Problem } from '../common/problem.js';
import type { RequestContext } from '../common/request-context.js';
import { AppConfig } from '../config/app-config.js';
import { Database } from '../database/database.js';
import { MailService } from '../mail/mail.service.js';
import { type Auth, type AuthSettings, createAuth } from './auth.js';
import { passesBotCheck } from './bot-check.js';
import { claimCooldown, clearCooldown, releaseCooldown } from './cooldown.js';
import { issuePendingToken, readPendingToken } from './pending.js';

export const SOCIAL_PROVIDERS = ['discord', 'github'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/** The signed-in account behind a request. */
export type Viewer = { accountId: string; sessionId: string; email: string };

/** What a successful call hands back to the browser, through the website: cookies to set or clear. */
export type CookieHeaders = Headers | null;

/** A pending sign-in: the token for the code step, whether a new code went out, and the wait before another. */
export type PendingCode = { pendingToken: string; sent: boolean; resendIn: number };

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof APIError)) return undefined;
  const code = (error.body as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (!(error instanceof APIError)) return undefined;
  const message = (error.body as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' ? message : undefined;
}

/**
 * Better Auth refuses sensitive changes (a new email, disconnecting a
 * provider, deleting the account) on a session older than its freshness
 * window. Signing in again fixes it, so that answer gets its own code.
 */
function isStaleSession(error: unknown): boolean {
  const code = errorCode(error);
  if (code === 'SESSION_EXPIRED' || code === 'SESSION_NOT_FRESH') return true;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return status === 401 || status === 403;
}

const UNAVAILABLE = 'Something went wrong on our side. Try again in a minute.';

/**
 * Everything the website asks of sign-in, on Better Auth. The rules are the
 * ones the website enforced before auth moved here, and they hold for any
 * caller: this is the boundary, not the website.
 */
@Injectable()
export class AuthService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AuthService.name);
  /** The auth login. int8 as number: the rate limiter and the cooldown do arithmetic on it. */
  readonly pool: pg.Pool;
  auth!: Auth;
  settings!: AuthSettings;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Database,
    private readonly audit: Audit,
    private readonly mail: MailService,
  ) {
    this.pool = new pg.Pool({
      ...config.database.auth,
      types: { getTypeParser: ((oid: number, format?: 'text') => (oid === 20 ? Number : pg.types.getTypeParser(oid, format))) as typeof pg.types.getTypeParser },
    });
  }

  async onModuleInit(): Promise<void> {
    const [codeLength, codeTtlSeconds, codeMaxAttempts, resendCooldownSeconds, signupsOpen, discordEnabled, githubEnabled] = await Promise.all([
      this.db.setting<number>('auth.email_code.length'),
      this.db.setting<number>('auth.email_code.ttl_seconds'),
      this.db.setting<number>('auth.email_code.max_attempts'),
      this.db.setting<number>('auth.email_code.resend_cooldown_seconds'),
      this.db.setting<boolean>('auth.signups_open'),
      this.db.setting<boolean>('auth.discord.enabled'),
      this.db.setting<boolean>('auth.github.enabled'),
    ]);
    // ponytail: read once; a changed setting applies after a restart.
    this.settings = { codeLength, codeTtlSeconds, codeMaxAttempts, resendCooldownSeconds, signupsOpen, discordEnabled, githubEnabled };

    this.auth = createAuth(this.config, this.pool, this.settings, {
      sendCode: (email, code, purpose) =>
        this.mail.send({
          to: email,
          accountId: null,
          template: purpose === 'sign-in' ? 'sign_in_code' : 'email_change_code',
          props: { code, minutes: Math.round(this.settings.codeTtlSeconds / 60) },
          category: 'auth',
        }),
      accountCreated: async (accountId, email, context) => {
        await this.log(fromHook(context), { action: 'signup.completed', actorType: 'account', actorAccountId: accountId, security: true });
        // Queued, not sent: nobody is waiting for it, and a slow Resend must
        // not slow down the moment an account is created.
        await this.mail.enqueue({
          to: email,
          accountId,
          template: 'welcome',
          props: { dashboardUrl: `${this.config.webOrigin}/dashboard` },
          category: 'transactional',
          idempotencyKey: `welcome:${accountId}`,
        });
      },
      sessionCreated: (accountId, sessionId, context) =>
        this.log(fromHook(context), {
          action: 'login.success',
          actorType: 'account',
          actorAccountId: accountId,
          targetType: 'session',
          targetId: sessionId,
          security: true,
        }),
      identityCreated: async (accountId, providerId, context) => {
        if ((SOCIAL_PROVIDERS as readonly string[]).includes(providerId)) {
          await this.log(fromHook(context), { action: `${providerId}.linked`, actorType: 'account', actorAccountId: accountId, security: true });
        }
      },
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }

  private log(context: RequestContext, event: AuditEvent): Promise<void> {
    return this.audit.record(context, event);
  }

  /** Which providers are offered: configured on this server and switched on in config.settings. */
  providers(): Record<SocialProvider, boolean> {
    return {
      discord: this.settings.discordEnabled && this.config.auth.discord !== null,
      github: this.settings.githubEnabled && this.config.auth.github !== null,
    };
  }

  async viewer(context: RequestContext): Promise<Viewer | null> {
    const result = await this.auth.api.getSession({ headers: context.headers });
    return result ? { accountId: result.user.id, sessionId: result.session.id, email: result.user.email } : null;
  }

  /* Email codes ------------------------------------------------------------ */

  /**
   * Send a sign-in code once the form's Turnstile token has passed. The check
   * comes before anything else, so a script that fails it learns nothing, not
   * even whether a code went out recently.
   */
  async requestSignInCode(context: RequestContext, rawEmail: string, botCheckToken: string): Promise<PendingCode> {
    const verdict = await passesBotCheck(this.config.auth.turnstileSecret, botCheckToken, context.ip);
    if (verdict === 'failed') {
      await this.log(context, { action: 'email_code.sent', result: 'denied', actorType: 'anonymous', metadata: { reason: 'bot_check' }, security: true });
      throw new Problem(403, 'bot_check_failed', 'The check that you are a person did not pass. Try again.');
    }
    if (verdict === 'unavailable') throw new Problem(503, 'unavailable', UNAVAILABLE);
    return this.sendSignInCode(context, rawEmail);
  }

  /**
   * Send another code to the address in a pending token. No new bot check:
   * only this API can sign one, only after a check passed, and it expires
   * with the code, so one check buys at most a code a minute, to one address.
   */
  async resendSignInCode(context: RequestContext, pendingToken: string): Promise<PendingCode> {
    const email = readPendingToken(this.config.auth.secret, pendingToken, this.settings.codeTtlSeconds);
    if (!email) throw new Problem(400, 'pending_expired', 'That sign-in has expired. Start again with your email address.');
    return this.sendSignInCode(context, email);
  }

  /**
   * The answer is the same whether or not the address has an account, so this
   * can't be used to find out who has one. The exception is when sign-ups are
   * closed, where saying so is the point.
   *
   * Inside the cooldown no code is sent, but the answer still carries a pending
   * token, dated to the code that did go out: a code reached this address a
   * moment ago, so the code step is where to be. The bot check has already
   * passed by the time this runs.
   */
  private async sendSignInCode(context: RequestContext, rawEmail: string): Promise<PendingCode> {
    const email = normalize(rawEmail);
    if (!EMAIL_SHAPE.test(email) || email.length > 254) throw new Problem(400, 'invalid_email', 'That is not an email address.');

    if (!this.settings.signupsOpen) {
      const auth = await this.auth.$context;
      if (!(await auth.internalAdapter.findUserByEmail(email))) {
        await this.log(context, { action: 'email_code.sent', result: 'denied', actorType: 'anonymous', metadata: { reason: 'signups_closed' }, security: true });
        throw new Problem(403, 'signups_closed', 'New accounts are closed for now.');
      }
    }

    const key = `email-code:${email}`;
    const slot = await claimCooldown(this.pool, key, this.settings.resendCooldownSeconds);
    if (slot.wait > 0) {
      return { pendingToken: issuePendingToken(this.config.auth.secret, email, slot.previous ?? Date.now()), sent: false, resendIn: slot.wait };
    }

    try {
      await this.auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' }, headers: context.headers });
    } catch (error) {
      await releaseCooldown(this.pool, key, slot.previous);
      if (errorCode(error) === 'INVALID_EMAIL') throw new Problem(400, 'invalid_email', 'That is not an email address.');
      this.logger.error(`Sending a sign-in code failed (request ${context.requestId})`, error instanceof Error ? error.stack : String(error));
      await this.log(context, { action: 'email_code.sent', result: 'failure', actorType: 'anonymous', security: true });
      throw new Problem(503, 'unavailable', UNAVAILABLE);
    }

    await this.log(context, { action: 'email_code.sent', actorType: 'anonymous', security: true });
    return { pendingToken: issuePendingToken(this.config.auth.secret, email), sent: true, resendIn: this.settings.resendCooldownSeconds };
  }

  /**
   * Tries left on the code sent to this address, or null when there is none.
   * Better Auth keeps the count inside its verification record
   * (`sign-in-otp-<email>` holding `<hash>:<attempts>`) and never returns it.
   * Reading it lets the last wrong code say at once that the code is used up.
   * If an upgrade changes the format this returns null, and the answer falls
   * back to a plain "doesn't match".
   */
  private async triesLeft(email: string): Promise<number | null> {
    const auth = await this.auth.$context;
    const record = await auth.internalAdapter.findVerificationValue(`sign-in-otp-${email}`);
    if (!record) return null;
    const used = Number(record.value.slice(record.value.lastIndexOf(':') + 1));
    return Number.isInteger(used) ? Math.max(0, this.settings.codeMaxAttempts - used) : null;
  }

  /** Check a code and, when it matches, sign in. A first sign-in creates the account. */
  async verifySignInCode(context: RequestContext, rawEmail: string, rawCode: string): Promise<CookieHeaders> {
    const email = normalize(rawEmail);
    const otp = rawCode.replace(/\D/g, '');
    if (otp.length !== this.settings.codeLength) throw new Problem(400, 'wrong_code', 'That code does not match.');

    let headers: CookieHeaders;
    try {
      ({ headers } = await this.auth.api.signInEmailOTP({ body: { email, otp }, headers: context.headers, returnHeaders: true }));
    } catch (error) {
      switch (errorCode(error)) {
        case 'OTP_EXPIRED':
          await this.log(context, { action: 'email_code.expired', result: 'failure', actorType: 'anonymous', security: true });
          throw new Problem(400, 'code_expired', 'That code has expired. Ask for a new one.');
        case 'TOO_MANY_ATTEMPTS':
          await this.log(context, { action: 'email_code.failed', result: 'denied', actorType: 'anonymous', security: true });
          throw new Problem(400, 'code_exhausted', 'That code has been tried too many times. Ask for a new one.');
        case 'INVALID_OTP': {
          await this.log(context, { action: 'email_code.failed', result: 'failure', actorType: 'anonymous', security: true });
          if ((await this.triesLeft(email)) === 0) {
            throw new Problem(400, 'code_exhausted', 'That code has been tried too many times. Ask for a new one.');
          }
          throw new Problem(400, 'wrong_code', 'That code does not match.');
        }
        default:
          this.logger.error(`Checking a sign-in code failed (request ${context.requestId})`, error instanceof Error ? error.stack : String(error));
          throw new Problem(503, 'unavailable', UNAVAILABLE);
      }
    }

    await clearCooldown(this.pool, `email-code:${email}`);
    await this.log(context, { action: 'email_code.verified', actorType: 'anonymous', security: true });
    return headers;
  }

  /* Discord and GitHub ----------------------------------------------------- */

  /**
   * The provider's address to send someone to, for signing in or for
   * connecting the provider to the signed-in account. The provider returns
   * them to `callbackURL` on approval, or to `errorCallbackURL` with an
   * `error` query parameter.
   */
  async startSocial(
    context: RequestContext,
    provider: SocialProvider,
    mode: 'sign-in' | 'link',
    callbackURL: string,
    errorCallbackURL: string,
  ): Promise<{ url: string; headers: CookieHeaders }> {
    if (!this.providers()[provider]) throw new Problem(404, 'provider_not_configured', `${provider} sign-in is not set up on this server.`);
    const body = { provider, callbackURL, errorCallbackURL, disableRedirect: true };
    try {
      const { headers, response } =
        mode === 'sign-in'
          ? await this.auth.api.signInSocial({ body, headers: context.headers, returnHeaders: true })
          : await this.auth.api.linkSocialAccount({ body, headers: context.headers, returnHeaders: true });
      if ('url' in response && typeof response.url === 'string') return { url: response.url, headers };
    } catch (error) {
      if (mode === 'link' && isStaleSession(error)) throw new Problem(403, 'session_stale', 'Sign in again to change this.');
      this.logger.error(`Starting ${provider} ${mode} failed (request ${context.requestId})`, error instanceof Error ? error.stack : String(error));
    }
    throw new Problem(503, 'unavailable', UNAVAILABLE);
  }

  /** Better Auth's id for each provider identity attached to the signed-in account. */
  private async identityIds(context: RequestContext): Promise<Partial<Record<SocialProvider, string>>> {
    const identities = await this.auth.api.listUserAccounts({ headers: context.headers });
    const ids: Partial<Record<SocialProvider, string>> = {};
    for (const identity of identities) {
      if ((SOCIAL_PROVIDERS as readonly string[]).includes(identity.providerId)) ids[identity.providerId as SocialProvider] = identity.id;
    }
    return ids;
  }

  async signInMethods(context: RequestContext): Promise<Record<SocialProvider, { configured: boolean; connected: boolean }>> {
    const ids = await this.identityIds(context);
    const offered = this.providers();
    return {
      discord: { configured: offered.discord, connected: ids.discord !== undefined },
      github: { configured: offered.github, connected: ids.github !== undefined },
    };
  }

  async unlinkSocial(context: RequestContext, viewer: Viewer, provider: SocialProvider): Promise<void> {
    try {
      const id = (await this.identityIds(context))[provider];
      if (!id) throw new Problem(404, 'not_connected', `No ${provider} account is connected.`);
      await this.auth.api.unlinkAccount({ body: { accountId: id }, headers: context.headers });
    } catch (error) {
      if (error instanceof Problem) throw error;
      if (isStaleSession(error)) throw new Problem(403, 'session_stale', 'Sign in again to change this.');
      this.logger.error(`Disconnecting ${provider} failed (request ${context.requestId})`, error instanceof Error ? error.stack : String(error));
      throw new Problem(503, 'unavailable', UNAVAILABLE);
    }
    await this.log(context, { action: `${provider}.unlinked`, actorType: 'account', actorAccountId: viewer.accountId, security: true });
  }

  /* The session ------------------------------------------------------------ */

  async signOut(context: RequestContext, viewer: Viewer | null): Promise<CookieHeaders> {
    const { headers } = await this.auth.api.signOut({ headers: context.headers, returnHeaders: true });
    if (viewer) {
      await this.log(context, { action: 'logout', actorType: 'account', actorAccountId: viewer.accountId, targetType: 'session', targetId: viewer.sessionId, security: true });
    }
    return headers;
  }

  /* Email change ----------------------------------------------------------- */

  /**
   * Send a code to a new address, to prove it can be read before the account
   * moves onto it. The answer is the same whether or not the address belongs
   * to another account: Better Auth quietly sends nothing, and no code matches.
   * Returns the seconds before another code can be sent.
   */
  async requestEmailChange(context: RequestContext, viewer: Viewer, rawEmail: string): Promise<number> {
    const newEmail = normalize(rawEmail);
    if (!EMAIL_SHAPE.test(newEmail) || newEmail.length > 254) throw new Problem(400, 'invalid_email', 'That is not an email address.');

    const key = `email-change:${newEmail}`;
    const slot = await claimCooldown(this.pool, key, this.settings.resendCooldownSeconds);
    if (slot.wait > 0) throw new Problem(429, 'cooldown', 'A code was sent to this address moments ago.', slot.wait);

    try {
      await this.auth.api.requestEmailChangeEmailOTP({ body: { newEmail }, headers: context.headers });
    } catch (error) {
      await releaseCooldown(this.pool, key, slot.previous);
      if (errorCode(error) === 'INVALID_EMAIL') throw new Problem(400, 'invalid_email', 'That is not an email address.');
      if (errorMessage(error) === 'Email is the same') throw new Problem(400, 'same_email', 'That is already your address.');
      if (isStaleSession(error)) throw new Problem(403, 'session_stale', 'Sign in again to change this.');
      this.logger.error(`Sending an email change code failed (request ${context.requestId})`, error instanceof Error ? error.stack : String(error));
      throw new Problem(503, 'unavailable', UNAVAILABLE);
    }

    await this.log(context, { action: 'account.email_change_requested', actorType: 'account', actorAccountId: viewer.accountId, security: true });
    return this.settings.resendCooldownSeconds;
  }

  /** Check the code sent to the new address and, when it matches, switch to it. */
  async confirmEmailChange(context: RequestContext, viewer: Viewer, rawEmail: string, rawCode: string): Promise<void> {
    const newEmail = normalize(rawEmail);
    const otp = rawCode.replace(/\D/g, '');
    if (otp.length !== this.settings.codeLength) throw new Problem(400, 'wrong_code', 'That code does not match.');

    try {
      await this.auth.api.changeEmailEmailOTP({ body: { newEmail, otp }, headers: context.headers });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'OTP_EXPIRED') throw new Problem(400, 'code_expired', 'That code has expired. Ask for a new one.');
      if (code === 'TOO_MANY_ATTEMPTS') throw new Problem(400, 'code_exhausted', 'That code has been tried too many times. Ask for a new one.');
      if (errorMessage(error) === 'Email already in use') throw new Problem(409, 'email_taken', 'That address belongs to another account.');
      // Any other code-shaped refusal, including a code never sent because the
      // address is taken, reads as a code that doesn't match.
      if (code?.includes('OTP')) throw new Problem(400, 'wrong_code', 'That code does not match.');
      if (isStaleSession(error)) throw new Problem(403, 'session_stale', 'Sign in again to change this.');
      this.logger.error(`Confirming an email change failed (request ${context.requestId})`, error instanceof Error ? error.stack : String(error));
      throw new Problem(503, 'unavailable', UNAVAILABLE);
    }

    await clearCooldown(this.pool, `email-change:${newEmail}`);
    await this.log(context, { action: 'account.email_changed', actorType: 'account', actorAccountId: viewer.accountId, security: true });
  }

  /**
   * Delete the signed-in account. The auth.accounts row cascades to the
   * VRChat connection, pages, groups, links, editor seats and invites; names
   * are held for slug.tombstone_days by a trigger.
   */
  async deleteAccount(context: RequestContext, viewer: Viewer): Promise<CookieHeaders> {
    let headers: CookieHeaders;
    try {
      ({ headers } = await this.auth.api.deleteUser({ body: {}, headers: context.headers, returnHeaders: true }));
    } catch (error) {
      if (isStaleSession(error)) throw new Problem(403, 'session_stale', 'Sign in again to delete your account.');
      this.logger.error(`Deleting an account failed (request ${context.requestId})`, error instanceof Error ? error.stack : String(error));
      throw new Problem(503, 'unavailable', UNAVAILABLE);
    }
    await this.log(context, { action: 'account.deleted', actorType: 'account', actorAccountId: viewer.accountId, security: true });
    // After the delete, and with no account id: the row is gone, and this is
    // the receipt for it. Only sent once the delete actually happened.
    await this.mail.enqueue({
      to: viewer.email,
      accountId: null,
      template: 'account_deleted',
      props: { tombstoneDays: await this.db.setting<number>('slug.tombstone_days') },
      category: 'transactional',
      idempotencyKey: `deleted:${viewer.accountId}`,
    });
    return headers;
  }
}

/**
 * The request behind a Better Auth database hook: its headers carry the
 * request id this API gave the request, the visitor's address and user agent.
 */
function fromHook(hookContext: unknown): RequestContext {
  const context = hookContext as { headers?: Headers; request?: Request } | null;
  const headers = context?.headers ?? context?.request?.headers ?? new Headers();
  const id = headers.get('x-request-id');
  const ip = headers.get('x-forwarded-for')?.trim() ?? null;
  return {
    requestId: id && /^[0-9a-f-]{36}$/i.test(id) ? id : randomUUID(),
    ip: ip && isIP(ip) ? ip : null,
    userAgent: headers.get('user-agent')?.slice(0, 1024) ?? null,
    headers,
  };
}
