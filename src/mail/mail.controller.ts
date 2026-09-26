/*
 * What Resend tells us afterwards.
 *
 * Resend posts here whenever a message is delivered, delayed, bounced or
 * marked as spam. The events are the only way to learn that an address is
 * dead, so this is also where suppressions come from.
 *
 * Not part of the website's contract: it is Resend calling, not a browser, so
 * it is kept out of openapi.json.
 */
import { Controller, HttpCode, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfig } from '../config/app-config.js';
import { Database } from '../database/database.js';
import type { MailMessageStatus, MailSuppressionReason } from '../database/database.types.js';
import { signatureHeaders, verifyWebhook } from './signature.js';

/**
 * A message only moves forward. A `sent` event arriving after `delivered`
 * (they can overtake each other) must not undo what we already know.
 */
const RANK: Partial<Record<MailMessageStatus, number>> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivery_delayed: 3,
  delivered: 4,
  bounced: 5,
  complained: 6,
};

const STATUS: Record<string, MailMessageStatus> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delivery_delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
};

/** The when-it-happened column that goes with each status. */
const STAMP: Partial<Record<MailMessageStatus, 'sentAt' | 'deliveredAt' | 'bouncedAt' | 'complainedAt'>> = {
  sent: 'sentAt',
  delivered: 'deliveredAt',
  bounced: 'bouncedAt',
  complained: 'complainedAt',
};

type Event = {
  type?: unknown;
  created_at?: unknown;
  data?: { email_id?: unknown; to?: unknown; bounce?: { type?: unknown } | null } | null;
};

@Controller('webhooks')
export class MailController {
  private readonly logger = new Logger(MailController.name);

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  /**
   * Always 204 once the signature holds, including for events we do nothing
   * with: a non-2xx makes Resend retry, and retrying an event we understood
   * and ignored helps nobody.
   */
  @Post('resend')
  @HttpCode(204)
  @ApiExcludeEndpoint()
  async resend(@Req() request: RawBodyRequest<Request>): Promise<void> {
    const secret = this.config.mail.webhookSecret;
    const body = request.rawBody;
    // Without a secret every caller is unsigned, so nothing is trusted.
    if (!secret || !body) throw new UnauthorizedException();

    const headers = signatureHeaders((name) => request.get(name));
    if (!verifyWebhook(secret, headers, body)) throw new UnauthorizedException();

    let event: Event;
    try {
      event = JSON.parse(body.toString('utf8')) as Event;
    } catch {
      throw new UnauthorizedException();
    }

    const type = typeof event.type === 'string' ? event.type : 'unknown';
    const emailId = typeof event.data?.email_id === 'string' ? event.data.email_id : null;
    const occurredAt = typeof event.created_at === 'string' ? new Date(event.created_at) : new Date();
    const status = STATUS[type];

    const actor = { requestId: request.id ?? randomUUID(), type: 'system' as const, accountId: null };
    await this.db.write(actor, async (trx) => {
      const message = emailId ? await trx.selectFrom('mail.messages').select(['id', 'status', 'toEmail']).where('resendEmailId', '=', emailId).executeTakeFirst() : undefined;

      const stored = await trx
        .insertInto('mail.events')
        .values({
          messageId: message?.id ?? null,
          resendEmailId: emailId,
          webhookId: headers.id!,
          type,
          occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
          payload: body.toString('utf8'),
        })
        // The same webhook delivered twice is stored once, and does nothing twice.
        .onConflict((conflict) => conflict.column('webhookId').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!stored) return;

      if (message && status && (RANK[status] ?? 0) > (RANK[message.status] ?? 0)) {
        const stamp = STAMP[status];
        await trx
          .updateTable('mail.messages')
          .set({ status, ...(stamp ? { [stamp]: occurredAt } : {}) })
          .where('id', '=', message.id)
          .execute();
      }

      // A permanent bounce means the address is gone; a complaint means they
      // asked not to hear from us. Both stop every later send to it.
      const reason = suppressionFor(type, event);
      const address = message?.toEmail ?? firstRecipient(event);
      if (reason && address) {
        await trx
          .insertInto('mail.suppressions')
          .values({ email: address, reason, sourceEventId: stored.id })
          .onConflict((conflict) => conflict.column('email').doNothing())
          .execute();
        this.logger.warn(`${address} is suppressed: ${reason}.`);
      }
    });
  }
}

function suppressionFor(type: string, event: Event): MailSuppressionReason | null {
  if (type === 'email.complained') return 'complaint';
  // A transient bounce is a full mailbox or a server having a bad day: the
  // address is still real, so it is not suppressed.
  if (type === 'email.bounced' && String(event.data?.bounce?.type ?? '').toLowerCase() === 'permanent') return 'hard_bounce';
  return null;
}

function firstRecipient(event: Event): string | null {
  const to = event.data?.to;
  if (typeof to === 'string') return to.toLowerCase();
  if (Array.isArray(to) && typeof to[0] === 'string') return (to[0] as string).toLowerCase();
  return null;
}
