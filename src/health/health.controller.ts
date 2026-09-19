import { Controller, Get, ServiceUnavailableException, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { AppConfig } from '../config/app-config.js';
import { Database } from '../database/database.js';
import { Liveness, Readiness } from './health.dto.js';

/** Unversioned, for load balancers and uptime checks. */
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  /** Liveness: the process is running. */
  @Get('live')
  live(): Liveness {
    return { status: 'ok' };
  }

  /** Readiness: the database answers and partitions exist 7 days ahead; 503 otherwise. */
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
    return { status: 'ok', environment: this.config.environment };
  }
}
