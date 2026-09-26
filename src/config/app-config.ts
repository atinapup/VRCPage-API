import { existsSync } from 'node:fs';
import { Injectable } from '@nestjs/common';
import type { PoolConfig } from 'pg';

/** development unless NODE_ENV says production; picks the .env.<environment> file. */
export const environment = process.env.NODE_ENV === 'production' ? 'production' : 'development';

/**
 * Reads .env.<environment> when it exists. Variables already set in the real
 * environment win, so a deployment can also provide everything without the file.
 */
export function loadEnvironmentFile(): void {
  const file = `.env.${environment}`;
  if (existsSync(file)) process.loadEnvFile(file);
}

const SSL_MODES = {
  disable: false,
  require: { rejectUnauthorized: false },
  'verify-full': true,
} as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.${environment}.example).`);
  return value;
}

/** An OAuth application, or null unless both halves are set. */
function oauthApp(prefix: 'DISCORD' | 'GITHUB'): { clientId: string; clientSecret: string } | null {
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Cloudflare's documented test secret: every token passes. Development only. */
const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA';

function databaseLogin(key: 'API' | 'AUTH'): PoolConfig {
  const sslMode = process.env.DB_SSL_MODE ?? 'disable';
  if (!(sslMode in SSL_MODES)) throw new Error(`DB_SSL_MODE "${sslMode}" is not one of: ${Object.keys(SSL_MODES).join(', ')}.`);
  return {
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    database: required('DB_NAME'),
    user: required(`DB_${key}_USER`),
    password: required(`DB_${key}_PASSWORD`),
    ssl: SSL_MODES[sslMode as keyof typeof SSL_MODES],
    application_name: key === 'AUTH' ? 'vrcpage-auth' : 'vrcpage-api',
  };
}

/** Every setting the API reads, checked once at start-up so a gap fails fast. */
@Injectable()
export class AppConfig {
  readonly environment = environment;
  readonly port = Number(process.env.PORT ?? 4000);
  /**
   * The website's origin. Allowed by CORS, and Better Auth's base URL: the
   * website proxies /api/auth/* here, so OAuth callbacks and cookies belong to it.
   */
  readonly webOrigin = required('WEB_ORIGIN');
  readonly database = { api: databaseLogin('API'), auth: databaseLogin('AUTH') };
  /**
   * Where our copies of VRChat images are served from (R2 keys are
   * images/<sha256 hex>.webp). Without it, pages show their fallback art.
   */
  readonly imagesBaseUrl = process.env.IMAGES_BASE_URL?.replace(/\/+$/, '') || null;
  readonly auth = {
    /** Signs sessions, OAuth state and pending sign-in tokens. At least 32 random characters. */
    secret: required('BETTER_AUTH_SECRET'),
    discord: oauthApp('DISCORD'),
    github: oauthApp('GITHUB'),
    /**
     * Turnstile's secret. Development falls back to Cloudflare's always-pass
     * test key (the website does the same for the site key). Production without
     * one refuses every code instead of letting bots through.
     */
    turnstileSecret: process.env.TURNSTILE_SECRET_KEY || (environment === 'production' ? null : TURNSTILE_TEST_SECRET),
  };
  /**
   * Email, through Resend. With no API key nothing is sent: every message is
   * printed to this terminal instead, which is what development wants and
   * what the website's /dev page reads codes from.
   */
  readonly mail = {
    apiKey: process.env.RESEND_API_KEY || null,
    /** The From address. Its domain has to be verified in Resend first. */
    from: process.env.MAIL_FROM || 'vrc.page <hello@vrc.page>',
    /** Where replies go, if anywhere. Unset means replies bounce off the From address. */
    replyTo: process.env.MAIL_REPLY_TO || null,
    /** Resend's signing secret (whsec_...). Without it no webhook is believed. */
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET || null,
  };

  constructor() {
    // A deployment with no sender can't sign anyone in, so it fails here
    // rather than at the first person who tries. The escape hatch is for
    // running a production build locally, never for a deployed one.
    if (environment === 'production' && !this.mail.apiKey && process.env.VRCPAGE_PRINT_SIGN_IN_CODES !== 'true') {
      throw new Error(
        'RESEND_API_KEY is not set, so no email can be sent and nobody can sign in. Set it, or set VRCPAGE_PRINT_SIGN_IN_CODES=true to print codes to this terminal instead.',
      );
    }
  }
}
