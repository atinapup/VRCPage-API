/*
 * Sending email, and the outbox behind it.
 *
 * Two ways in, and the difference is who is waiting:
 *   send()     the person is staring at a code field. Sent inside the
 *              request, and a failure is a failure they are told about.
 *   enqueue()  nobody is waiting. Written to mail.messages as `queued` and
 *              picked up by the drainer, so a slow Resend never slows a page.
 *
 * Everything lands in mail.messages either way, which is the record of what
 * was sent: the outbox, the retries, and what Resend later said about it.
 */
import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Transaction, Updateable } from 'kysely';
import { notePrintedCode } from '../auth/delivery.js';
import { AppConfig } from '../config/app-config.js';
import { Database } from '../database/database.js';
import type { DB, MailCategory } from '../database/database.types.js';
import { sendThroughResend } from './resend.js';
import { content, render, storableProps, type TemplateName, type TemplateProps } from './templates.js';

/** How often the outbox is looked at. Nothing queued is urgent; this is not a job queue. */
const DRAIN_INTERVAL_MS = 15_000;
/** Rows taken per pass. Resend allows two sends a second, so this stays small. */
const DRAIN_BATCH = 10;
/** Tries before a message is given up on, counting the first. */
const MAX_ATTEMPTS = 5;
/** 1, 5, 25 then 125 minutes: long enough for an outage to end, short enough to still matter. */
const BACKOFF_MINUTES = (attempts: number) => 5 ** (attempts - 1);

/** Which switch in Settings turns an email off. Auth and account mail has none: it always goes. */
type Preference = 'notifyGroupInvites' | 'notifyPageChanges' | 'notifyProductNews';

export type Letter<K extends TemplateName = TemplateName> = {
  to: string;
  /** Who it is about, for the record. Null for someone with no account (or one just deleted). */
  accountId: string | null;
  template: K;
  props: TemplateProps[K];
  category: MailCategory;
  preference?: Preference;
  /** A name for this exact message ("invite:<id>"), so the same one is never sent twice. */
  idempotencyKey?: string;
};

type Row = {
  id: string;
  toEmail: string;
  template: string;
  category: MailCategory;
  props: unknown;
  accountId: string | null;
  attempts: number;
};

@Injectable()
export class MailService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MailService.name);
  private timer: NodeJS.Timeout | null = null;
  private draining = false;

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  /** Whether email can actually leave this server. False means codes are printed instead. */
  get configured(): boolean {
    return this.config.mail.apiKey !== null;
  }

  onApplicationBootstrap(): void {
    if (!this.configured) this.logger.warn('No RESEND_API_KEY: email is printed to this terminal instead of sent.');
    // The drainer runs either way, so a queued message is printed in
    // development rather than sitting in the outbox for ever.
    this.timer = setInterval(() => void this.drain(), DRAIN_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Send now and wait for the answer. Throws when the message did not leave,
   * because the only thing worse than a code that doesn't arrive is a page
   * that says it did.
   */
  async send<K extends TemplateName>(letter: Letter<K>): Promise<void> {
    const row = await this.record(letter, 'sending');
    if (!row) return; // Suppressed or switched off: nothing to wait for.
    const failure = await this.deliver(row, letter.props as Record<string, unknown>);
    if (failure) throw new Error(`Sending ${letter.template} failed: ${failure}`);
  }

  /** Write it to the outbox and return. The drainer sends it within the minute. */
  async enqueue<K extends TemplateName>(letter: Letter<K>): Promise<void> {
    await this.record(letter, 'queued');
  }

  /**
   * The row for a message, or null when it must not be sent: a suppressed
   * address, a switch turned off in Settings, or a message already recorded
   * under the same idempotency key.
   */
  private async record<K extends TemplateName>(letter: Letter<K>, status: 'queued' | 'sending'): Promise<Row | null> {
    const to = letter.to.trim().toLowerCase();
    const subject = content(letter.template, letter.props).subject;

    const suppression = await this.db.selectFrom('mail.suppressions').select('reason').where('email', '=', to).executeTakeFirst();
    // A hard bounce means the address does not exist, so nothing is worth
    // sending. A complaint means they marked us as spam: no notifications,
    // but a code they just asked for still goes, or they can never sign in.
    const blocked = suppression && (suppression.reason === 'hard_bounce' || letter.category === 'notification' || letter.category === 'product');

    if (!blocked && letter.preference && letter.accountId && !(await this.wants(letter.accountId, letter.preference))) return null;

    const actor = { requestId: randomUUID(), type: 'system' as const, accountId: null };
    return this.db.write(actor, async (trx) => {
      const row = await trx
        .insertInto('mail.messages')
        .values({
          accountId: letter.accountId,
          toEmail: to,
          template: letter.template,
          category: letter.category,
          subject,
          props: JSON.stringify(storableProps(letter.props as Record<string, unknown>)),
          status: blocked ? 'suppressed' : status,
          idempotencyKey: letter.idempotencyKey ?? null,
        })
        .onConflict((conflict) => conflict.column('idempotencyKey').doNothing())
        .returning(['id', 'toEmail', 'template', 'category', 'props', 'accountId', 'attempts'])
        .executeTakeFirst();
      // No row: this exact message was recorded before, so it is not sent again.
      return blocked ? null : (row ?? null);
    });
  }

  private async wants(accountId: string, preference: Preference): Promise<boolean> {
    const row = await this.db.selectFrom('auth.notificationPreferences').select(preference).where('accountId', '=', accountId).executeTakeFirst();
    return row ? row[preference] : true; // No row means the defaults, which are on.
  }

  /**
   * Render, hand to Resend, and write down what happened. Returns null when
   * the message went, or the reason it didn't.
   */
  private async deliver(row: Row, props: Record<string, unknown>): Promise<string | null> {
    const body = content(row.template as TemplateName, props as never);
    const unsubscribeUrl = row.category === 'notification' || row.category === 'product' ? `${this.config.webOrigin}/dashboard?settings=notifications` : null;
    const rendered = render(body, unsubscribeUrl);

    if (!this.configured) {
      // Development without a sender. The row is kept so the outbox is real
      // while testing; a `sent` row with no Resend id was printed, not sent.
      notePrintedCode(row.template, row.toEmail, props);
      this.logger.log(`\n  To ${row.toEmail}: ${rendered.subject}\n${rendered.text.replace(/^/gm, '  ')}\n`);
      await this.finish(row.id, { status: 'sent', sentAt: new Date() });
      return null;
    }

    const result = await sendThroughResend(this.config.mail.apiKey!, {
      from: this.config.mail.from,
      to: row.toEmail,
      replyTo: this.config.mail.replyTo,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      // The row's id, so a retry of this row is the same send to Resend.
      idempotencyKey: row.id,
      ...(unsubscribeUrl ? { headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` } } : {}),
    });

    if (result.ok) {
      await this.finish(row.id, { status: 'sent', sentAt: new Date(), resendEmailId: result.id });
      return null;
    }

    const attempts = row.attempts + 1;
    // A code is never retried from the outbox: its props are stored without
    // the code, so a second try would send an email with nothing in it. They
    // expire in minutes anyway, and the person can just ask for another.
    const giveUp = !result.retry || attempts >= MAX_ATTEMPTS || row.category === 'auth';
    await this.finish(row.id, {
      status: giveUp ? 'failed' : 'queued',
      lastError: result.error.slice(0, 2000),
      scheduledFor: giveUp ? undefined : new Date(Date.now() + BACKOFF_MINUTES(attempts) * 60_000),
    });
    this.logger.warn(`${row.template} to ${row.toEmail} ${giveUp ? 'failed' : `will be tried again (${attempts}/${MAX_ATTEMPTS})`}: ${result.error}`);
    return giveUp ? result.error : null;
  }

  /** Write down how a send went. Every finish is one more attempt on the record. */
  private finish(id: string, change: Updateable<DB['mail.messages']>): Promise<unknown> {
    const actor = { requestId: randomUUID(), type: 'system' as const, accountId: null };
    return this.db.write(actor, (trx) =>
      trx
        .updateTable('mail.messages')
        .set({ ...change, attempts: (eb) => eb('attempts', '+', 1) })
        .where('id', '=', id)
        .execute(),
    );
  }

  /** One pass over the outbox: take what is due, send it, leave the rest for the next pass. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const actor = { requestId: randomUUID(), type: 'system' as const, accountId: null };
      const due = await this.db.write(actor, (trx) => this.claim(trx));
      for (const row of due) await this.deliver(row, (row.props ?? {}) as Record<string, unknown>);
    } catch (error) {
      this.logger.error('Draining the outbox failed', error instanceof Error ? error.stack : String(error));
    } finally {
      this.draining = false;
    }
  }

  /**
   * Take the due rows and mark them `sending` in one transaction. SKIP LOCKED
   * means a second API process takes different rows rather than waiting, so
   * no message is ever sent twice.
   */
  private async claim(trx: Transaction<DB>): Promise<Row[]> {
    const rows = await trx
      .selectFrom('mail.messages')
      .select(['id', 'toEmail', 'template', 'category', 'props', 'accountId', 'attempts'])
      .where('status', '=', 'queued')
      .where('scheduledFor', '<=', new Date())
      .orderBy('scheduledFor')
      .limit(DRAIN_BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    if (rows.length === 0) return [];
    await trx
      .updateTable('mail.messages')
      .set({ status: 'sending' })
      .where(
        'id',
        'in',
        rows.map((row) => row.id),
      )
      .execute();
    return rows;
  }
}
