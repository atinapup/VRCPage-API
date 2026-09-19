import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { AppConfig } from '../config/app-config.js';
import type { DB } from './database.types.js';

/**
 * The database, as the API login. Tables are addressed as 'schema.table'
 * ('pages.slugs') and columns in camelCase; CamelCasePlugin maps them to the
 * snake_case in Postgres. Types come from `npm run db:types`.
 */
@Injectable()
export class Database extends Kysely<DB> implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(config: AppConfig) {
    super({
      dialect: new PostgresDialect({ pool: new pg.Pool(config.database.api) }),
      plugins: [new CamelCasePlugin()],
    });
  }

  /** Partitioned tables have no DEFAULT partition, so the coming ones must exist before any insert. */
  async onApplicationBootstrap(): Promise<void> {
    await sql`SELECT internal.ensure_partitions()`.execute(this);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.destroy();
  }
}
