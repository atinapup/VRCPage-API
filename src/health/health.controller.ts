import { Controller, Get, Logger, ServiceUnavailableException, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { AuthService } from '../auth/auth.service.js';
import { RateLimit } from '../common/rate-limit.js';
import { AppConfig } from '../config/app-config.js';
import { Database } from '../database/database.js';
import { Liveness, Readiness } from './health.dto.js';

/** Unversioned, for load balancers and uptime checks. */
@ApiTags('health')
@RateLimit(false)
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly db: Database,
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  /** Liveness: the process is running. */
  @Get('live')
  live(): Liveness {
    return { status: 'ok' };
  }

  /**
   * Readiness: both database logins answer and partitions exist 7 days ahead;
   * 503 otherwise.
   *
   * Both, because the API signs in twice. Everything the site renders uses the
   * api login, and Better Auth uses its own, and only the second one can sign
   * anybody in. Checking one and reporting "ok" is how a deployment with a bad
   * DB_AUTH_PASSWORD served every page perfectly while no one could log in.
   */
  @Get('ready')
  async ready(): Promise<Readiness> {
    let ready: boolean;
    try {
      const { rows } = await sql<{ ready: boolean }>`
        SELECT to_regclass('pages.views_' || to_char(week_ahead, 'YYYYMMDD')) IS NOT NULL
           AND to_regclass('audit.events_' || to_char(week_ahead, 'YYYYMM')) IS NOT NULL
           AND to_regclass('audit.row_changes_' || to_char(week_ahead, 'YYYYMM')) IS NOT NULL AS ready
          FROM (SELECT (now() AT TIME ZONE 'UTC') + interval '7 days' AS week_ahead) AS t
      `.execute(this.db);
      ready = rows[0].ready;
    } catch {
      throw new ServiceUnavailableException('The database is not answering.');
    }
    if (!ready) {
      throw new ServiceUnavailableException('Partitions for the next 7 days are missing; run internal.ensure_partitions().');
    }

    // Better Auth's own login, on its own pool. A wrong password here is
    // invisible to every other query the API makes. The database's own words
    // (host, login name) go to the log, not to whoever asked: this is public.
    try {
      await this.auth.pool.query('SELECT 1');
    } catch (error) {
      this.logger.error('Better Auth cannot reach the database, so nobody can sign in.', error instanceof Error ? error.message : String(error));
      throw new ServiceUnavailableException('Better Auth cannot reach the database, so nobody can sign in.');
    }

    return { status: 'ok', environment: this.config.environment };
  }
}
