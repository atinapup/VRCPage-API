import { Global, Injectable, Logger, Module } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/database.js';
import type { AuditActorType, AuditResult, DB } from '../database/database.types.js';

export type AuditEvent = {
  /** e.g. login.success, slug.claimed: `<area>.<what happened>`. */
  action: string;
  result?: AuditResult;
  actorType: AuditActorType;
  actorAccountId?: string | null;
  targetType?: string;
  targetId?: string;
  /** Never a secret, an email address or a page name: ids say who and what. */
  metadata?: Record<string, string | number | boolean>;
  /** Sign-in and account events: kept longer, and with the full IP (spec section 14). */
  security?: boolean;
};

/** Writes audit.events, the record of who did what, including failures and refusals. */
@Injectable()
export class Audit {
  private readonly logger = new Logger(Audit.name);

  constructor(private readonly db: Database) {}

  /**
   * Inside a write transaction, pass it as `executor` so the event commits or
   * rolls back with the change it describes. On its own, a failed insert is
   * logged and swallowed: losing one log row must not fail a sign-in.
   */
  async record(context: RequestContext, event: AuditEvent, executor?: Kysely<DB>): Promise<void> {
    const insert = (executor ?? this.db).insertInto('audit.events').values({
      requestId: context.requestId,
      actorType: event.actorType,
      actorAccountId: event.actorAccountId ?? null,
      ip: event.security ? context.ip : null,
      userAgent: event.security ? context.userAgent : null,
      action: event.action,
      result: event.result ?? 'success',
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      retention: event.security ? 'security' : 'standard',
      metadata: event.metadata ?? {},
    });
    if (executor) {
      await insert.execute();
      return;
    }
    try {
      await insert.execute();
    } catch (error) {
      this.logger.error(`Audit event ${event.action} for request ${context.requestId} was not written`, error instanceof Error ? error.stack : String(error));
    }
  }
}

@Global()
@Module({ providers: [Audit], exports: [Audit] })
export class AuditModule {}
