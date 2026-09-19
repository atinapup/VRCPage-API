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

function databaseLogin(key: 'API'): PoolConfig {
  const sslMode = process.env.DB_SSL_MODE ?? 'disable';
  if (!(sslMode in SSL_MODES)) throw new Error(`DB_SSL_MODE "${sslMode}" is not one of: ${Object.keys(SSL_MODES).join(', ')}.`);
  return {
    host: required('DB_HOST'),
    port: Number(process.env.DB_PORT ?? 5432),
    database: required('DB_NAME'),
    user: required(`DB_${key}_USER`),
    password: required(`DB_${key}_PASSWORD`),
    ssl: SSL_MODES[sslMode as keyof typeof SSL_MODES],
    application_name: 'vrcpage-api',
  };
}

/** Every setting the API reads, checked once at start-up so a gap fails fast. */
@Injectable()
export class AppConfig {
  readonly environment = environment;
  readonly port = Number(process.env.PORT ?? 4000);
  /** The website's origin, allowed by CORS. */
  readonly webOrigin = required('WEB_ORIGIN');
  readonly database = { api: databaseLogin('API') };
}
