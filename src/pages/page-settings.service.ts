import { Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import { Audit } from '../audit/audit.js';
import type { RequestContext } from '../common/request-context.js';
import { sniff } from '../common/upload.js';
import { Database } from '../database/database.js';
import type { DB } from '../database/database.types.js';
import { encodeUploadedBanner, imagePath, saveUploadedImage } from '../vrchat/images.js';
import { checkLink, linkIdentity } from './links.js';
import type { Preferences } from './page-settings.dto.js';
import { PagesService } from './pages.service.js';

/*
 * What an owner decides about how their page looks and what it shows, beyond
 * its name and who can open it: the Socials page, which of VRChat's links
 * show, an accent colour, and a banner for when VRChat has none. Owners and
 * editors may both change these, the same as links: they are how the page
 * looks, not who it belongs to. And how vrc.page itself looks for one
 * account: higher contrast and a dyslexia font.
 */

/** #rrggbb, lowercase on the way in. */
const ACCENT = /^#[0-9a-f]{6}$/;

/** A banner is a picture, and none needs to be bigger than this to look right. */
export const BANNER_LIMIT = 8 * 1024 * 1024;

const NOTHING_BLOCKED: ReadonlySet<string> = new Set();

export type SettingResult = 'ok' | 'not_found';
export type BannerResult = { status: 'ok'; url: string } | { status: 'not_found' } | { status: 'not_a_picture' } | { status: 'too_large' };

@Injectable()
export class PageSettingsService {
  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
    private readonly pages: PagesService,
  ) {}

  /** One write on a page this account runs: not_found for any other, as for everything under /v1/me. */
  private async onPage(
    context: RequestContext,
    accountId: string,
    pageId: string,
    action: string,
    metadata: Record<string, string | number | boolean>,
    change: (trx: Transaction<DB>) => Promise<void>,
  ): Promise<SettingResult> {
    return this.db.write({ requestId: context.requestId, type: 'account', accountId }, async (trx) => {
      if (!(await this.pages.role(trx, accountId, pageId))) return 'not_found';
      await change(trx);
      await this.audit.record(context, { action, actorType: 'account', actorAccountId: accountId, targetType: 'page', targetId: pageId, metadata }, trx);
      return 'ok';
    });
  }

  /** Turn the page's Socials page on or off. Off, vrc.page/<name>/socials goes to the profile. */
  setSocials(context: RequestContext, accountId: string, pageId: string, enabled: boolean): Promise<SettingResult> {
    return this.onPage(context, accountId, pageId, 'page.socials_changed', { enabled }, async (trx) => {
      await trx.updateTable('pages.pages').set({ socialsEnabled: enabled }).where('id', '=', pageId).execute();
    });
  }

  /**
   * Show or hide one of VRChat's links. Those have no row of their own, so
   * hiding remembers the link's identity; the page's own links are hidden
   * with the rest of their settings, in the links save.
   */
  async setLinkHidden(context: RequestContext, accountId: string, pageId: string, url: string, hidden: boolean): Promise<SettingResult | 'bad_link'> {
    const check = checkLink(url, NOTHING_BLOCKED);
    if (check.status !== 'ok') return 'bad_link';
    const identity = linkIdentity(check.url);
    return this.onPage(context, accountId, pageId, hidden ? 'link_item.hidden' : 'link_item.shown', { host: check.host }, async (trx) => {
      if (hidden) {
        await trx.insertInto('pages.hiddenLinks').values({ pageId, identity }).onConflict((oc) => oc.columns(['pageId', 'identity']).doNothing()).execute();
      } else {
        await trx.deleteFrom('pages.hiddenLinks').where('pageId', '=', pageId).where('identity', '=', identity).execute();
      }
    });
  }

  /** The page's accent colour, or null for vrc.page's own. */
  async setAccent(context: RequestContext, accountId: string, pageId: string, accent: string | null): Promise<SettingResult | 'bad_colour'> {
    const colour = accent === null ? null : accent.trim().toLowerCase();
    if (colour !== null && !ACCENT.test(colour)) return 'bad_colour';
    return this.onPage(context, accountId, pageId, 'page.accent_changed', { accent: colour ?? 'default' }, async (trx) => {
      await trx.updateTable('pages.pages').set({ accent: colour }).where('id', '=', pageId).execute();
    });
  }

  /**
   * A banner of the page's own, shown while VRChat has none. Re-encoded like
   * VRChat's (src/vrchat/images.ts) before anything is written; the picture
   * it replaces goes as soon as nothing uses it (migration 20261002090300).
   */
  async setBanner(context: RequestContext, accountId: string, pageId: string, bytes: Buffer): Promise<BannerResult> {
    if (bytes.length > BANNER_LIMIT) return { status: 'too_large' };
    const kind = sniff(bytes);
    if (kind !== 'png' && kind !== 'jpeg' && kind !== 'webp' && kind !== 'gif') return { status: 'not_a_picture' };
    const encoded = await encodeUploadedBanner(bytes);
    if (!encoded) return { status: 'not_a_picture' };

    const result = await this.onPage(context, accountId, pageId, 'page.banner_changed', { uploaded: true }, async (trx) => {
      const imageId = await saveUploadedImage(trx, encoded);
      await trx.updateTable('pages.pages').set({ bannerImageId: imageId }).where('id', '=', pageId).execute();
    });
    return result === 'ok' ? { status: 'ok', url: imagePath(encoded.sha256)! } : { status: 'not_found' };
  }

  removeBanner(context: RequestContext, accountId: string, pageId: string): Promise<SettingResult> {
    return this.onPage(context, accountId, pageId, 'page.banner_changed', { uploaded: false }, async (trx) => {
      await trx.updateTable('pages.pages').set({ bannerImageId: null }).where('id', '=', pageId).execute();
    });
  }

  /* How vrc.page looks for this account --------------------------------- */

  async preferences(accountId: string): Promise<Preferences> {
    const row = await this.db
      .selectFrom('auth.accountPreferences')
      .select(['highContrast', 'dyslexiaFont'])
      .where('accountId', '=', accountId)
      .executeTakeFirst();
    return { highContrast: row?.highContrast ?? false, dyslexiaFont: row?.dyslexiaFont ?? false };
  }

  /** No row means the defaults, so the first change writes one. */
  async setPreferences(context: RequestContext, accountId: string, patch: Partial<Preferences>): Promise<Preferences> {
    const current = await this.preferences(accountId);
    const next: Preferences = {
      highContrast: patch.highContrast ?? current.highContrast,
      dyslexiaFont: patch.dyslexiaFont ?? current.dyslexiaFont,
    };
    return this.db.write({ requestId: context.requestId, type: 'account', accountId }, async (trx) => {
      await trx
        .insertInto('auth.accountPreferences')
        .values({ accountId, ...next })
        .onConflict((conflict) => conflict.column('accountId').doUpdateSet(next))
        .execute();
      await this.audit.record(context, { action: 'account.preferences_changed', actorType: 'account', actorAccountId: accountId, metadata: { ...next } }, trx);
      return next;
    });
  }
}
