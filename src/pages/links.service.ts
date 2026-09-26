import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Audit } from '../audit/audit.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/database.js';
import type { DB } from '../database/database.types.js';
import type { LinkInput, OwnLink, PageLinks } from './links.dto.js';
import { checkLink, linkIdentity } from './links.js';
import { PagesService } from './pages.service.js';

/*
 * The links a page adds on vrc.page, beside the ones mirrored from VRChat.
 *
 * The whole list is saved at once, in order, so adding, editing, reordering
 * and removing are one kind of write. A row keeps its id while its address
 * stays the same, so only a link that really came or went is recorded as
 * added or removed.
 *
 * Owners and editors may both edit links: it is the whole of an editor's job.
 */

export type SaveFailure =
  | { status: 'not_found' }
  | { status: 'disabled' }
  | { status: 'too_many'; max: number }
  | { status: 'bad_link'; at: number; reason: 'empty' | 'not_url' | 'not_https' | 'blocked' | 'duplicate' | 'label_too_long' };

export type SaveResult = { status: 'ok'; links: OwnLink[] } | SaveFailure;

@Injectable()
export class LinksService {
  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
    private readonly pages: PagesService,
  ) {}

  private async settings() {
    const [enabled, max, labelMax, blocked] = await Promise.all([
      this.db.setting<boolean>('links.custom.enabled'),
      this.db.setting<number>('links.custom.max_per_page'),
      this.db.setting<number>('links.custom.label_max_length'),
      this.db.setting<string[]>('links.custom.blocked_hosts'),
    ]);
    return { enabled, max, labelMax, blocked: new Set(blocked.map((host) => host.toLowerCase())) };
  }

  private rows(executor: Kysely<DB>, pageId: string) {
    return executor.selectFrom('pages.links').select(['id', 'url', 'label']).where('pageId', '=', pageId).orderBy('position').execute();
  }

  /** A page's own links, or null when this account doesn't run that page. */
  async list(accountId: string, pageId: string): Promise<PageLinks | null> {
    const role = await this.pages.role(this.db, accountId, pageId);
    if (!role) return null;
    const settings = await this.settings();
    return { links: await this.rows(this.db, pageId), max: settings.max, labelMax: settings.labelMax, enabled: settings.enabled };
  }

  /** Replace a page's links with this ordered list. */
  async save(context: RequestContext, accountId: string, pageId: string, inputs: LinkInput[]): Promise<SaveResult> {
    const settings = await this.settings();
    if (!settings.enabled) return { status: 'disabled' };
    if (inputs.length > settings.max) return { status: 'too_many', max: settings.max };

    // Everything is checked before anything is written, so a list with one
    // bad address in it changes nothing at all.
    const wanted: Array<{ url: string; label: string | null; identity: string }> = [];
    const seen = new Set<string>();
    for (const [at, input] of inputs.entries()) {
      const check = checkLink(String(input?.url ?? ''), settings.blocked);
      if (check.status !== 'ok') {
        if (check.status === 'blocked') {
          await this.audit.record(context, {
            action: 'link_item.rejected_blocked_domain',
            result: 'denied',
            actorType: 'account',
            actorAccountId: accountId,
            targetType: 'page',
            targetId: pageId,
            metadata: { host: check.host },
          });
        }
        return { status: 'bad_link', at, reason: check.status };
      }

      const identity = linkIdentity(check.url);
      if (seen.has(identity)) return { status: 'bad_link', at, reason: 'duplicate' };
      seen.add(identity);

      const label = typeof input?.label === 'string' ? input.label.trim() : '';
      if (Array.from(label).length > settings.labelMax) return { status: 'bad_link', at, reason: 'label_too_long' };
      wanted.push({ url: check.url, label: label || null, identity });
    }

    return this.db.write({ requestId: context.requestId, type: 'account', accountId }, async (trx) => {
      const role = await this.pages.role(trx, accountId, pageId);
      if (!role) return { status: 'not_found' as const };

      const before = await this.rows(trx, pageId);
      const byIdentity = new Map(before.map((row) => [linkIdentity(row.url), row]));
      const keep = new Set(wanted.map((link) => link.identity));

      for (const row of before) {
        if (keep.has(linkIdentity(row.url))) continue;
        await trx.deleteFrom('pages.links').where('id', '=', row.id).execute();
        await this.audit.record(
          context,
          { action: 'link_item.removed', actorType: 'account', actorAccountId: accountId, targetType: 'link', targetId: row.id },
          trx,
        );
      }

      for (const [position, link] of wanted.entries()) {
        const existing = byIdentity.get(link.identity);
        if (existing) {
          // The same link, so it keeps its id: only where it sits and what it
          // is called can have changed.
          await trx.updateTable('pages.links').set({ url: link.url, label: link.label, position, updatedAt: new Date() }).where('id', '=', existing.id).execute();
          continue;
        }
        const added = await trx.insertInto('pages.links').values({ pageId, url: link.url, label: link.label, position }).returning('id').executeTakeFirstOrThrow();
        await this.audit.record(
          context,
          { action: 'link_item.added', actorType: 'account', actorAccountId: accountId, targetType: 'link', targetId: added.id },
          trx,
        );
      }

      return { status: 'ok' as const, links: await this.rows(trx, pageId) };
    });
  }
}
