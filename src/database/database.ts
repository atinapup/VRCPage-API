import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { CamelCasePlugin, Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { AppConfig } from '../config/app-config.js';
import type { AuditActorType, DB } from './database.types.js';

/** Who a write is for. Row history (audit.row_changes) records it with every change. */
export type WriteActor = { requestId: string; type: AuditActorType; accountId: string | null };

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

  /**
   * Every write goes through here: one transaction that first tells the
   * database who is acting (docs/database.md, "What the API must do"), so row
   * history can't lose track of who made a change.
   */
  write<T>(actor: WriteActor, change: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.transaction().execute(async (trx) => {
      await sql`
        SELECT set_config('app.request_id', ${actor.requestId}, true),
               set_config('app.actor_type', ${actor.type}, true),
               set_config('app.actor_account_id', ${actor.accountId ?? ''}, true)
      `.execute(trx);
      return change(trx);
    });
  }

  /** A tunable limit from config.settings, as its JSON value. */
  async setting<T>(key: string): Promise<T> {
    const { rows } = await sql<{ value: T }>`SELECT internal.setting(${key}) AS value`.execute(this);
    return rows[0].value;
  }

  /** Partitioned tables have no DEFAULT partition, so the coming ones must exist before any insert. */
  async onApplicationBootstrap(): Promise<void> {
    await sql`SELECT internal.ensure_partitions()`.execute(this);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.destroy();
  }
}
