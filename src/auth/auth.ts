import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins/email-otp';
import type pg from 'pg';
import type { AppConfig } from '../config/app-config.js';
import type { CodePurpose } from './delivery.js';

/** The auth.* settings from config.settings, read once at start-up. */
export type AuthSettings = {
  codeLength: number;
  codeTtlSeconds: number;
  codeMaxAttempts: number;
  resendCooldownSeconds: number;
  signupsOpen: boolean;
  discordEnabled: boolean;
  githubEnabled: boolean;
};

export type AuthHooks = {
  sendCode(email: string, code: string, purpose: CodePurpose): Promise<void>;
  /** Better Auth's endpoint context: its headers carry the request id, IP and user agent. */
  accountCreated(accountId: string, context: unknown): Promise<void>;
  sessionCreated(accountId: string, sessionId: string, context: unknown): Promise<void>;
  identityCreated(accountId: string, providerId: string, context: unknown): Promise<void>;
};

/**
 * Better Auth, on the auth login (search_path = auth), with the field mapping
 * from docs/database.md. Better Auth checks the schema at start-up, and that
 * check is the test that the mapping is right.
 */
export function createAuth(config: AppConfig, pool: pg.Pool, settings: AuthSettings, hooks: AuthHooks) {
  const discord = settings.discordEnabled ? config.auth.discord : null;
  const github = settings.githubEnabled ? config.auth.github : null;

  return betterAuth({
    appName: 'vrc.page',
    // The website proxies /api/auth/* here. Its origin is the one the browser
    // sees, so OAuth callbacks and cookies belong to it.
    baseURL: config.webOrigin,
    trustedOrigins: [config.webOrigin],
    secret: config.auth.secret,
    database: pool,
    advanced: {
      cookiePrefix: 'vrcpage',
      // Postgres generates uuidv7 ids.
      database: { generateId: false },
    },
    // The email-code endpoints answer only this API's own server-side calls
    // (src/auth/auth.service.ts). Over HTTP they would let a script send codes
    // to any address without the Turnstile check in front of them.
    disabledPaths: [
      '/email-otp/send-verification-otp',
      '/email-otp/check-verification-otp',
      '/email-otp/verify-email',
      '/sign-in/email-otp',
      '/email-otp/request-email-change',
      '/email-otp/change-email',
      '/email-otp/request-password-reset',
      '/forget-password/email-otp',
      '/email-otp/reset-password',
    ],
    socialProviders: {
      ...(discord ? { discord } : {}),
      // GitHub's default scopes include user:email, which is how the primary
      // address, and whether GitHub has verified it, are read.
      ...(github ? { github } : {}),
    },
    user: {
      modelName: 'accounts',
      fields: { emailVerified: 'is_email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
      // Deleting the auth.accounts row cascades to everything the account owns
      // (docs/database.md, "What one delete does").
      deleteUser: { enabled: true },
    },
    session: {
      modelName: 'sessions',
      fields: {
        userId: 'account_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    account: {
      modelName: 'identities',
      encryptOAuthTokens: true,
      fields: {
        userId: 'account_id',
        accountId: 'provider_account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      accountLinking: {
        // A Discord or GitHub sign-in joins an existing account with the same
        // email only when the provider reports that email as verified. No
        // provider is trusted without that proof.
        enabled: true,
        trustedProviders: [],
        // Every account can sign in with a code sent to its email, so
        // disconnecting a provider never locks anyone out.
        allowUnlinkingAll: true,
      },
    },
    verification: {
      modelName: 'verifications',
      fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    rateLimit: { storage: 'database', modelName: 'rate_limits', fields: { lastRequest: 'last_request' } },
    databaseHooks: {
      user: { create: { after: async (user, context) => hooks.accountCreated(user.id, context) } },
      session: { create: { after: async (session, context) => hooks.sessionCreated(session.userId, session.id, context) } },
      account: {
        create: { after: async (identity, context) => hooks.identityCreated(identity.userId, identity.providerId, context) },
      },
    },
    plugins: [
      emailOTP({
        otpLength: settings.codeLength,
        expiresIn: settings.codeTtlSeconds,
        allowedAttempts: settings.codeMaxAttempts,
        // Only a hash is stored, so reading the table never reveals a live code.
        storeOTP: 'hashed',
        // Asking for another code cancels the one before it.
        resendStrategy: 'rotate',
        disableSignUp: !settings.signupsOpen,
        // A new address is confirmed with a code sent to it, so nobody can move
        // an account onto an address they can't read.
        changeEmail: { enabled: true },
        async sendVerificationOTP({ email, otp, type }) {
          if (type === 'sign-in') await hooks.sendCode(email, otp, 'sign-in');
          if (type === 'change-email') await hooks.sendCode(email, otp, 'change-email');
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
