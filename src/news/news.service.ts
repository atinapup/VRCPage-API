import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import sharp from 'sharp';
import { Audit } from '../audit/audit.js';
import type { RequestContext } from '../common/request-context.js';
import { sniff } from '../common/upload.js';
import { Database } from '../database/database.js';
import type { DB } from '../database/database.types.js';
import type { AdminUpdate, Update, UpdatesFeed } from './news.dto.js';

/*
 * "What's new": notes about changes to vrc.page, written by an admin and
 * shown once to each signed-in account.
 *
 * A picture (GIFs included) is re-encoded to WebP, keeping its animation and
 * dropping anything else the file carried. A clip is kept as it was sent,
 * MP4 or WebM, up to MEDIA_LIMIT. Both are named by the hash of what is
 * stored, and served at /updates/media/<hex>.<ext> on the website.
 */

/** The largest picture or clip an update takes: 25 MB. */
const MEDIA_LIMIT = 25 * 1024 * 1024;

/** Pictures in an update fill a dialog about 560px wide. */
const MEDIA_BOX = 1600;
const QUALITY = 82;
/** Refuses decompression bombs, across all of an animation's frames. */
const MAX_PIXELS = 200_000_000;
const FEED_SIZE = 10;

const EXTENSION: Record<string, string> = { 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm' };
const TYPE_FOR: Record<string, string> = { webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm' };

export type MediaResult = 'ok' | 'not_found' | 'not_media';

type Row = {
  id: string;
  title: string;
  body: string;
  publishedAt: Date | null;
  sha256: Buffer | null;
  contentType: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function present(row: Row): Update {
  const extension = row.contentType ? EXTENSION[row.contentType] : null;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    mediaUrl: row.sha256 && extension ? `/updates/media/${row.sha256.toString('hex')}.${extension}` : null,
    mediaKind: row.contentType ? (row.contentType.startsWith('video/') ? 'video' : 'image') : null,
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class NewsService {
  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
  ) {}

  private rows() {
    return this.db
      .selectFrom('news.updates as u')
      .leftJoin('news.media as m', 'm.id', 'u.mediaId')
      .select(['u.id', 'u.title', 'u.body', 'u.publishedAt', 'u.createdAt', 'u.updatedAt', 'm.sha256', 'm.contentType']);
  }

  /**
   * The latest published updates and where this account has read up to. An
   * account that has never looked starts at its own creation, so nobody is
   * greeted with every update since the site began.
   */
  async feed(accountId: string): Promise<UpdatesFeed> {
    const [rows, seen] = await Promise.all([
      this.rows().where('u.publishedAt', 'is not', null).orderBy('u.publishedAt', 'desc').limit(FEED_SIZE).execute(),
      this.db
        .selectFrom('auth.accounts as a')
        .leftJoin('auth.accountPreferences as p', 'p.accountId', 'a.id')
        .select(['a.createdAt', 'p.updatesSeenAt'])
        .where('a.id', '=', accountId)
        .executeTakeFirst(),
    ]);
    const seenAt = seen?.updatesSeenAt ?? seen?.createdAt ?? new Date();
    return { updates: rows.map(present), seenAt: seenAt.toISOString() };
  }

  /** Everything published so far has been seen. */
  async markSeen(context: RequestContext, accountId: string): Promise<void> {
    await this.db.write({ requestId: context.requestId, type: 'account', accountId }, async (trx) => {
      const now = new Date();
      await trx
        .insertInto('auth.accountPreferences')
        .values({ accountId, updatesSeenAt: now })
        .onConflict((conflict) => conflict.column('accountId').doUpdateSet({ updatesSeenAt: now }))
        .execute();
    });
  }

  /** A stored picture or clip, by the name the website serves it at. */
  async media(file: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    const match = /^([0-9a-f]{64})\.(webp|mp4|webm)$/.exec(file);
    if (!match) return null;
    const row = await this.db
      .selectFrom('news.media')
      .select(['bytes', 'contentType'])
      .where('sha256', '=', Buffer.from(match[1], 'hex'))
      .where('contentType', '=', TYPE_FOR[match[2]])
      .executeTakeFirst();
    return row ?? null;
  }

  /* Admins ----------------------------------------------------------------- */

  private event(adminId: string, action: string, targetId: string, metadata?: Record<string, string | number | boolean>) {
    return { action, actorType: 'staff' as const, actorAccountId: adminId, targetType: 'update', targetId, metadata };
  }

  private actor(context: RequestContext, adminId: string) {
    return { requestId: context.requestId, type: 'staff' as const, accountId: adminId };
  }

  async list(): Promise<AdminUpdate[]> {
    const rows = await this.rows().orderBy('u.createdAt', 'desc').execute();
    return rows.map((row) => ({ ...present(row), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
  }

  async one(id: string): Promise<AdminUpdate | null> {
    const row = await this.rows().where('u.id', '=', id).executeTakeFirst();
    return row ? { ...present(row), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() } : null;
  }

  async create(context: RequestContext, adminId: string, title: string, body: string): Promise<string> {
    return this.db.write(this.actor(context, adminId), async (trx) => {
      const row = await trx.insertInto('news.updates').values({ title, body, createdBy: adminId }).returning('id').executeTakeFirstOrThrow();
      await this.audit.record(context, this.event(adminId, 'admin.update_created', row.id), trx);
      return row.id;
    });
  }

  /** Change the words, or publish or unpublish. Publishing again keeps the first time it went out. */
  async change(context: RequestContext, adminId: string, id: string, patch: { title?: string; body?: string; published?: boolean }): Promise<boolean> {
    return this.db.write(this.actor(context, adminId), async (trx) => {
      const current = await trx.selectFrom('news.updates').select('publishedAt').where('id', '=', id).executeTakeFirst();
      if (!current) return false;
      const publishedAt = patch.published === undefined ? current.publishedAt : patch.published ? (current.publishedAt ?? new Date()) : null;
      await trx
        .updateTable('news.updates')
        .set({ ...(patch.title !== undefined && { title: patch.title }), ...(patch.body !== undefined && { body: patch.body }), publishedAt })
        .where('id', '=', id)
        .execute();
      const action = patch.published === true && !current.publishedAt ? 'admin.update_published' : patch.published === false && current.publishedAt ? 'admin.update_unpublished' : 'admin.update_changed';
      await this.audit.record(context, this.event(adminId, action, id), trx);
      return true;
    });
  }

  async remove(context: RequestContext, adminId: string, id: string): Promise<boolean> {
    return this.db.write(this.actor(context, adminId), async (trx) => {
      const gone = await trx.deleteFrom('news.updates').where('id', '=', id).returning('mediaId').executeTakeFirst();
      if (!gone) return false;
      await this.dropUnused(trx, gone.mediaId);
      await this.audit.record(context, this.event(adminId, 'admin.update_deleted', id), trx);
      return true;
    });
  }

  /** Attach a picture or clip, replacing any there was. Checked and encoded before anything is written. */
  async setMedia(context: RequestContext, adminId: string, id: string, bytes: Buffer): Promise<MediaResult> {
    if (bytes.length > MEDIA_LIMIT) return 'not_media';
    const kind = sniff(bytes);
    let stored: { bytes: Buffer; contentType: string; width: number | null; height: number | null };
    if (kind === 'mp4' || kind === 'webm') {
      stored = { bytes, contentType: `video/${kind}`, width: null, height: null };
    } else if (kind) {
      try {
        const { data, info } = await sharp(bytes, { animated: true, limitInputPixels: MAX_PIXELS })
          .resize({ width: MEDIA_BOX, height: MEDIA_BOX, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: QUALITY })
          .toBuffer({ resolveWithObject: true });
        stored = { bytes: data, contentType: 'image/webp', width: info.width, height: info.pageHeight ?? info.height };
      } catch {
        return 'not_media';
      }
    } else {
      return 'not_media';
    }
    const sha256 = createHash('sha256').update(stored.bytes).digest();

    return this.db.write(this.actor(context, adminId), async (trx) => {
      const update = await trx.selectFrom('news.updates').select('mediaId').where('id', '=', id).executeTakeFirst();
      if (!update) return 'not_found';
      const existing = await trx.selectFrom('news.media').select('id').where('sha256', '=', sha256).executeTakeFirst();
      const mediaId =
        existing?.id ??
        (
          await trx
            .insertInto('news.media')
            .values({ sha256, contentType: stored.contentType, bytes: stored.bytes, byteSize: stored.bytes.length, width: stored.width, height: stored.height })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      await trx.updateTable('news.updates').set({ mediaId }).where('id', '=', id).execute();
      if (update.mediaId !== mediaId) await this.dropUnused(trx, update.mediaId);
      await this.audit.record(context, this.event(adminId, 'admin.update_media_set', id, { contentType: stored.contentType, bytes: stored.bytes.length }), trx);
      return 'ok';
    });
  }

  async clearMedia(context: RequestContext, adminId: string, id: string): Promise<boolean> {
    return this.db.write(this.actor(context, adminId), async (trx) => {
      const update = await trx.selectFrom('news.updates').select('mediaId').where('id', '=', id).executeTakeFirst();
      if (!update) return false;
      await trx.updateTable('news.updates').set({ mediaId: null }).where('id', '=', id).execute();
      await this.dropUnused(trx, update.mediaId);
      await this.audit.record(context, this.event(adminId, 'admin.update_media_removed', id), trx);
      return true;
    });
  }

  /** A picture or clip no update uses any more goes, so the table holds only what is shown. */
  private async dropUnused(trx: Transaction<DB>, mediaId: string | null): Promise<void> {
    if (!mediaId) return;
    await trx
      .deleteFrom('news.media')
      .where('id', '=', mediaId)
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom('news.updates').select('id').where('mediaId', '=', mediaId))))
      .execute();
  }
}
