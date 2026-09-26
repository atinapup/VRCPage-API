import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Audit } from '../audit/audit.js';
import type { RequestContext } from '../common/request-context.js';
import { AppConfig } from '../config/app-config.js';
import { Database } from '../database/database.js';
import type { DB } from '../database/database.types.js';
import type {
  Dashboard,
  NameAvailability,
  DashboardPage,
  GroupPage,
  NotificationPreferences,
  OwnGroupPage,
  OwnUserPage,
  PageLink,
  PublicPage,
  UserPage,
} from './pages.dto.js';

type Visibility = UserPage['visibility'];

/** What an account may do with a page. Anything else is not its page at all. */
export type PageRole = 'owner' | 'editor';

/** What giving a page a name can answer. */
export type SetNameResult =
  | { status: 'ok'; slug: string }
  | { status: 'not_found' }
  | { status: 'not_allowed' }
  | { status: 'unavailable'; availability: NameAvailability }
  | { status: 'cooldown'; availableAt: string };


/** Pages and the dashboard. Every answer is built from the database, per request. */
@Injectable()
export class PagesService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly audit: Audit,
  ) {}

  /**
   * This account's standing on a page, from the database rather than anything
   * the caller said: it owns its own page through the VRChat connection, owns
   * a group through the connection that claimed it, and edits one by its seat.
   * Null for every other page, including ones that don't exist.
   */
  async role(executor: Kysely<DB>, accountId: string, pageId: string): Promise<PageRole | null> {
    const row = await executor
      .selectFrom('pages.pages as p')
      .leftJoin('vrchat.users as u', 'u.id', 'p.vrchatUserId')
      .leftJoin('vrchat.groups as g', 'g.id', 'p.vrchatGroupId')
      .leftJoin('vrchat.users as claimer', 'claimer.id', 'g.claimedByVrchatUserId')
      .leftJoin('pages.editors as e', (join) => join.onRef('e.pageId', '=', 'p.id').on('e.accountId', '=', accountId))
      .select((eb) => [
        eb('u.accountId', '=', accountId).as('ownsUserPage'),
        eb('claimer.accountId', '=', accountId).as('ownsGroup'),
        eb('e.accountId', 'is not', null).as('edits'),
      ])
      .where('p.id', '=', pageId)
      .executeTakeFirst();
    if (!row) return null;
    if (row.ownsUserPage || row.ownsGroup) return 'owner';
    return row.edits ? 'editor' : null;
  }

  private imageUrl(sha256: Buffer | null): string | null {
    return sha256 && this.config.imagesBaseUrl ? `${this.config.imagesBaseUrl}/images/${sha256.toString('hex')}.webp` : null;
  }

  private async primarySlug(pageId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('pages.slugs')
      .select('slug')
      .where('pageId', '=', pageId)
      .where('role', '=', 'primary')
      .executeTakeFirst();
    return row?.slug ?? null;
  }

  /**
   * A group's name on vrc.page, only while its page is public: linking an
   * unlisted one from somebody else's page would publish its address.
   */
  private async publicGroupSlug(vrchatGroupId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('pages.pages as p')
      .innerJoin('pages.slugs as s', (join) => join.onRef('s.pageId', '=', 'p.id').on('s.role', '=', 'primary'))
      .select('s.slug')
      .where('p.vrchatGroupId', '=', vrchatGroupId)
      .where('p.visibility', '=', 'public')
      .where('p.hiddenAt', 'is', null)
      .executeTakeFirst();
    return row?.slug ?? null;
  }

  /** VRChat's links first, then the page's own, in order. */
  private async links(pageId: string, fromVRChat: string[]): Promise<PageLink[]> {
    const own = await this.db.selectFrom('pages.links').select(['url', 'label']).where('pageId', '=', pageId).orderBy('position').execute();
    return [
      ...fromVRChat.map((url) => ({ url, label: null, source: 'vrchat' as const })),
      ...own.map((link) => ({ url: link.url, label: link.label, source: 'vrcpage' as const })),
    ];
  }

  private async userPage(pageId: string): Promise<UserPage | null> {
    const row = await this.db
      .selectFrom('pages.pages as p')
      .innerJoin('vrchat.users as u', 'u.id', 'p.vrchatUserId')
      .leftJoin('vrchat.images as icon', 'icon.id', 'u.iconImageId')
      .leftJoin('vrchat.images as banner', 'banner.id', 'u.bannerImageId')
      .select([
        'p.visibility',
        'u.id',
        'u.displayName',
        'u.pronouns',
        'u.isAgeVerified',
        'u.trustRank',
        'u.representedGroupId',
        'u.representedGroupName',
        'u.status',
        'u.statusDescription',
        'u.bio',
        'u.bioLinks',
        'u.languages',
        'u.connectedAt',
        'u.fetchedAt',
        'icon.sha256 as iconSha256',
        'banner.sha256 as bannerSha256',
      ])
      .where('p.id', '=', pageId)
      .executeTakeFirst();
    if (!row) return null;

    return {
      vrchatUserId: row.id,
      displayName: row.displayName,
      pronouns: row.pronouns,
      ageVerified: row.isAgeVerified,
      trustRank: row.trustRank,
      group:
        row.representedGroupId && row.representedGroupName
          ? { id: row.representedGroupId, name: row.representedGroupName, slug: await this.publicGroupSlug(row.representedGroupId) }
          : null,
      status: row.status,
      statusDescription: row.statusDescription,
      bio: row.bio || null,
      links: await this.links(pageId, row.bioLinks),
      languages: row.languages,
      bannerUrl: this.imageUrl(row.bannerSha256),
      avatarUrl: this.imageUrl(row.iconSha256),
      verifiedAt: row.connectedAt.toISOString(),
      lastRefreshedAt: row.fetchedAt.toISOString(),
      visibility: row.visibility,
    };
  }

  private async groupPage(pageId: string): Promise<GroupPage | null> {
    const row = await this.db
      .selectFrom('pages.pages as p')
      .innerJoin('vrchat.groups as g', 'g.id', 'p.vrchatGroupId')
      .innerJoin('vrchat.users as claimer', 'claimer.id', 'g.claimedByVrchatUserId')
      .leftJoin('pages.pages as ownerPage', 'ownerPage.vrchatUserId', 'claimer.id')
      .leftJoin('vrchat.images as icon', 'icon.id', 'g.iconImageId')
      .leftJoin('vrchat.images as banner', 'banner.id', 'g.bannerImageId')
      .select([
        'p.visibility',
        'g.id',
        'g.name',
        'g.shortCode',
        'g.discriminator',
        'g.description',
        'g.rules',
        'g.links',
        'g.languages',
        'g.memberCount',
        'g.isVerified',
        'g.claimedAt',
        'g.fetchedAt',
        'claimer.displayName as ownerName',
        'ownerPage.id as ownerPageId',
        'ownerPage.visibility as ownerVisibility',
        'ownerPage.hiddenAt as ownerHiddenAt',
        'icon.sha256 as iconSha256',
        'banner.sha256 as bannerSha256',
      ])
      .where('p.id', '=', pageId)
      .executeTakeFirst();
    if (!row) return null;

    const ownerPublic = row.ownerPageId !== null && row.ownerVisibility === 'public' && row.ownerHiddenAt === null;
    return {
      vrchatGroupId: row.id,
      name: row.name,
      shortCode: row.shortCode,
      discriminator: row.discriminator,
      description: row.description || null,
      rules: row.rules || null,
      links: await this.links(pageId, row.links),
      languages: row.languages,
      memberCount: row.memberCount,
      isVerified: row.isVerified,
      iconUrl: this.imageUrl(row.iconSha256),
      bannerUrl: this.imageUrl(row.bannerSha256),
      owner: { displayName: row.ownerName, slug: ownerPublic ? await this.primarySlug(row.ownerPageId!) : null },
      verifiedAt: row.claimedAt.toISOString(),
      lastRefreshedAt: row.fetchedAt.toISOString(),
      visibility: row.visibility,
    };
  }

  /**
   * The page at a name. Private, hidden by a moderator, held after release,
   * or never taken all come back null, so every miss looks the same.
   */
  async publicPage(slug: string): Promise<PublicPage | null> {
    const found = await this.db
      .selectFrom('pages.slugs as s')
      .innerJoin('pages.pages as p', 'p.id', 's.pageId')
      .select(['p.id', 'p.kind', 'p.visibility', 'p.hiddenAt', 's.role'])
      .where('s.slugKey', '=', slug.toLowerCase())
      .executeTakeFirst();
    if (!found || found.visibility === 'private' || found.hiddenAt !== null) return null;

    const primary = await this.primarySlug(found.id);
    if (!primary) return null;
    const alias = found.role === 'alias';

    if (found.kind === 'user') {
      const user = await this.userPage(found.id);
      return user ? { kind: 'user', slug: primary, alias, user } : null;
    }
    const group = await this.groupPage(found.id);
    return group ? { kind: 'group', slug: primary, alias, group } : null;
  }

  /* The signed-in account's own pages ------------------------------------- */

  /** The account's user page: its id and VRChat user id, or null before VRChat is connected. */
  private async ownUserPageRow(accountId: string) {
    return this.db
      .selectFrom('vrchat.users as u')
      .innerJoin('pages.pages as p', 'p.vrchatUserId', 'u.id')
      .select(['p.id', 'u.id as vrchatUserId'])
      .where('u.accountId', '=', accountId)
      .executeTakeFirst();
  }

  async ownUserPage(accountId: string): Promise<OwnUserPage | null> {
    const row = await this.ownUserPageRow(accountId);
    if (!row) return null;
    const page = await this.userPage(row.id);
    return page ? { pageId: row.id, slug: await this.primarySlug(row.id), ...(await this.waits(row.id)), page } : null;
  }

  /**
   * When this page may next be refreshed by hand, from the last manual job for
   * it; null when it can now. A read VRChat failed doesn't count, the same as
   * a claim check: it said nothing about the page.
   */
  async refreshableAt(pageId: string): Promise<string | null> {
    const cooldownSeconds = await this.db.setting<number>('refresh.manual.cooldown_seconds');
    const last = await this.db
      .selectFrom('vrchat.jobs')
      .select('createdAt')
      .where('pageId', '=', pageId)
      .where('lane', '=', 'manual')
      .where('status', '!=', 'failed')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!last) return null;
    const next = last.createdAt.getTime() + cooldownSeconds * 1000;
    return next > Date.now() ? new Date(next).toISOString() : null;
  }

  /**
   * When the page's name and a manual refresh are next allowed, said up front
   * so a screen never offers something only to refuse it.
   */
  private async waits(pageId: string): Promise<{ nameChangeableAt: string | null; refreshableAt: string | null }> {
    const cooldownDays = await this.db.setting<number>('slug.change_cooldown_days');
    const page = await this.db.selectFrom('pages.pages').select('slugChangedAt').where('id', '=', pageId).executeTakeFirstOrThrow();
    return { nameChangeableAt: this.nextRename(page.slugChangedAt, cooldownDays), refreshableAt: await this.refreshableAt(pageId) };
  }

  /** Group pages this account owns (through its VRChat connection) or edits, with its role on each. */
  private async groupRoles(accountId: string): Promise<Array<{ pageId: string; role: 'owner' | 'editor' }>> {
    const owned = await this.db
      .selectFrom('vrchat.users as u')
      .innerJoin('vrchat.groups as g', 'g.claimedByVrchatUserId', 'u.id')
      .innerJoin('pages.pages as p', 'p.vrchatGroupId', 'g.id')
      .select('p.id')
      .where('u.accountId', '=', accountId)
      .orderBy('g.claimedAt')
      .execute();
    const edited = await this.db
      .selectFrom('pages.editors')
      .select('pageId')
      .where('accountId', '=', accountId)
      .orderBy('addedAt')
      .execute();
    return [...owned.map((row) => ({ pageId: row.id, role: 'owner' as const })), ...edited.map((row) => ({ pageId: row.pageId, role: 'editor' as const }))];
  }

  /** A group page this account owns or edits, or null: someone else's group looks like no group. */
  async ownGroupPage(accountId: string, pageId: string): Promise<OwnGroupPage | null> {
    const role = (await this.groupRoles(accountId)).find((entry) => entry.pageId === pageId)?.role;
    if (!role) return null;
    const page = await this.groupPage(pageId);
    return page ? { pageId, slug: await this.primarySlug(pageId), role, ...(await this.waits(pageId)), page } : null;
  }

  async dashboard(accountId: string): Promise<Dashboard> {
    const own = await this.ownUserPage(accountId);
    const roles = await this.groupRoles(accountId);

    const groups: DashboardPage[] = [];
    for (const { pageId, role } of roles) {
      const group = await this.groupPage(pageId);
      if (!group) continue;
      groups.push({
        id: pageId,
        kind: 'group',
        name: group.name,
        slug: await this.primarySlug(pageId),
        visibility: group.visibility,
        role,
        iconUrl: group.iconUrl,
        vrchatId: group.vrchatGroupId,
        memberCount: group.memberCount,
      });
    }

    const maxGroups = await this.db.setting<number>('groups.max_per_user');
    const owned = roles.filter((entry) => entry.role === 'owner').length;
    const invites = await this.db
      .selectFrom('pages.editorInvites')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('invitedAccountId', '=', accountId)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();

    return {
      user: own
        ? {
            id: own.pageId,
            kind: 'user',
            name: own.page.displayName,
            slug: own.slug,
            visibility: own.page.visibility as Visibility,
            role: 'owner',
            iconUrl: own.page.avatarUrl,
            vrchatId: own.page.vrchatUserId,
            memberCount: null,
          }
        : null,
      groups,
      groupClaimsLeft: Math.max(0, maxGroups - owned),
      pendingInvites: Number(invites.count),
    };
  }

  async notificationPreferences(accountId: string): Promise<NotificationPreferences> {
    const row = await this.db
      .selectFrom('auth.notificationPreferences')
      .select(['notifyGroupInvites', 'notifyPageChanges', 'notifyProductNews'])
      .where('accountId', '=', accountId)
      .executeTakeFirst();
    return {
      groupInvites: row?.notifyGroupInvites ?? true,
      pageChanges: row?.notifyPageChanges ?? true,
      productNews: row?.notifyProductNews ?? false,
    };
  }

  /* Writes ---------------------------------------------------------------- */

  /**
   * Public, unlisted or private, in effect on the next request. Only the
   * owner: an editor could otherwise unpublish a community's page.
   */
  async setVisibility(context: RequestContext, accountId: string, pageId: string, visibility: Visibility): Promise<'ok' | 'not_found' | 'not_allowed'> {
    return this.db.write({ requestId: context.requestId, type: 'account', accountId }, async (trx) => {
      const role = await this.role(trx, accountId, pageId);
      if (!role) return 'not_found';
      if (role !== 'owner') return 'not_allowed';

      const page = await trx.updateTable('pages.pages').set({ visibility }).where('id', '=', pageId).returning('kind').executeTakeFirstOrThrow();
      await this.audit.record(
        context,
        {
          action: 'profile.visibility_changed',
          actorType: 'account',
          actorAccountId: accountId,
          targetType: page.kind === 'user' ? 'profile' : 'group',
          targetId: pageId,
          metadata: { visibility },
        },
        trx,
      );
      return 'ok';
    });
  }

  /** Which emails this account gets. No row means the defaults, so the first change writes one. */
  async setNotificationPreferences(
    context: RequestContext,
    accountId: string,
    patch: Partial<NotificationPreferences>,
  ): Promise<NotificationPreferences> {
    const current = await this.notificationPreferences(accountId);
    const next: NotificationPreferences = {
      groupInvites: patch.groupInvites ?? current.groupInvites,
      pageChanges: patch.pageChanges ?? current.pageChanges,
      productNews: patch.productNews ?? current.productNews,
    };

    return this.db.write({ requestId: context.requestId, type: 'account', accountId }, async (trx) => {
      const row = { notifyGroupInvites: next.groupInvites, notifyPageChanges: next.pageChanges, notifyProductNews: next.productNews };
      await trx
        .insertInto('auth.notificationPreferences')
        .values({ accountId, ...row })
        .onConflict((conflict) => conflict.column('accountId').doUpdateSet(row))
        .execute();
      await this.audit.record(context, { action: 'account.notifications_changed', actorType: 'account', actorAccountId: accountId, metadata: { ...next } }, trx);
      return next;
    });
  }

  /**
   * Disconnect VRChat. The database takes the rest with it: the page, every
   * group claimed through that connection and their pages, their links,
   * editors and invites. A trigger holds every name released this way for
   * slug.tombstone_days, so nobody can take it straight afterwards.
   */
  async disconnectVRChat(context: RequestContext, accountId: string): Promise<boolean> {
    return this.db.write({ requestId: context.requestId, type: 'account', accountId }, async (trx) => {
      const connection = await trx.deleteFrom('vrchat.users').where('accountId', '=', accountId).returning('id').executeTakeFirst();
      if (!connection) return false;
      await this.audit.record(
        context,
        { action: 'link.unlinked', actorType: 'account', actorAccountId: accountId, targetType: 'vrchat_user', targetId: connection.id, security: true },
        trx,
      );
      return true;
    });
  }

  /* Names ----------------------------------------------------------------- */

  private async nameSettings() {
    const [minLength, maxLength, reserved, blocked, cooldownDays, tombstoneDays] = await Promise.all([
      this.db.setting<number>('slug.min_length'),
      this.db.setting<number>('slug.max_length'),
      this.db.setting<string[]>('slug.reserved'),
      this.db.setting<string[]>('slug.blocked_substrings'),
      this.db.setting<number>('slug.change_cooldown_days'),
      this.db.setting<number>('slug.tombstone_days'),
    ]);
    return { minLength, maxLength, reserved, blocked, cooldownDays, tombstoneDays };
  }

  /**
   * Whether a name can be given to a page. Users and groups share one pool,
   * and a name released in the last slug.tombstone_days is still held, so
   * nobody can pick it up to pass as whoever had it.
   *
   * "held" is kept apart from "taken" for this layer's honesty. A screen may
   * word them alike: saying a name was recently given up tells a stranger
   * something about whoever gave it up.
   */
  async nameAvailability(name: string, pageId: string | null = null): Promise<NameAvailability> {
    const settings = await this.nameSettings();
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    const shape = { minLength: settings.minLength, maxLength: settings.maxLength };

    if (trimmed.length < settings.minLength) return { status: 'too_short', ...shape };
    if (trimmed.length > settings.maxLength) return { status: 'too_long', ...shape };
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return { status: 'invalid', ...shape };
    if (settings.reserved.includes(key)) return { status: 'reserved', ...shape };
    if (settings.blocked.some((word) => key.includes(word.toLowerCase()))) return { status: 'impersonation', ...shape };

    const row = await this.db.selectFrom('pages.slugs').select(['pageId', 'blockedUntil']).where('slugKey', '=', key).executeTakeFirst();
    if (!row) return { status: 'available', ...shape };
    if (row.pageId) return { status: row.pageId === pageId ? 'yours' : 'taken', ...shape };
    return row.blockedUntil && row.blockedUntil.getTime() > Date.now() ? { status: 'held', ...shape } : { status: 'available', ...shape };
  }

  /** When this page's name may next change, or null when it can now. */
  private nextRename(slugChangedAt: Date | null, cooldownDays: number): string | null {
    if (!slugChangedAt) return null;
    const next = slugChangedAt.getTime() + cooldownDays * 24 * 60 * 60 * 1000;
    return next > Date.now() ? new Date(next).toISOString() : null;
  }

  /**
   * Give a page its name, or change it.
   *
   * The first name is free to pick. The cooldown starts with the first
   * change, so a typo on day one can still be fixed. A replaced name is held
   * for slug.tombstone_days. Changing only the capitals keeps the same name
   * and costs nothing.
   */
  async setName(
    context: RequestContext,
    accountId: string,
    pageId: string,
    name: string,
  ): Promise<SetNameResult> {
    const settings = await this.nameSettings();

    return this.db.write({ requestId: context.requestId, type: 'account', accountId }, async (trx) => {
      // Nobody is told anything about a page, or a name for it, before they
      // are shown to run that page.
      const role = await this.role(trx, accountId, pageId);
      if (!role) return { status: 'not_found' as const };
      if (role !== 'owner') return { status: 'not_allowed' as const };

      const availability = await this.nameAvailability(name, pageId);
      if (availability.status !== 'available' && availability.status !== 'yours') {
        return { status: 'unavailable' as const, availability };
      }

      const slug = name.trim();
      const page = await trx.selectFrom('pages.pages').select(['slugChangedAt']).where('id', '=', pageId).executeTakeFirstOrThrow();
      const current = await trx
        .selectFrom('pages.slugs')
        .select(['slugKey', 'slug'])
        .where('pageId', '=', pageId)
        .where('role', '=', 'primary')
        .executeTakeFirst();

      // Only the capitals changed: the same name, so no hold and no cooldown.
      if (current && current.slugKey === slug.toLowerCase()) {
        if (current.slug !== slug) await trx.updateTable('pages.slugs').set({ slug }).where('slugKey', '=', current.slugKey).execute();
        return { status: 'ok' as const, slug };
      }

      const waitUntil = this.nextRename(page.slugChangedAt, settings.cooldownDays);
      if (waitUntil) return { status: 'cooldown' as const, availableAt: waitUntil };

      if (current) {
        await trx
          .updateTable('pages.slugs')
          .set({ pageId: null, releasedAt: new Date(), blockedUntil: new Date(Date.now() + settings.tombstoneDays * 24 * 60 * 60 * 1000) })
          .where('slugKey', '=', current.slugKey)
          .execute();
        await this.audit.record(context, { action: 'slug.released', actorType: 'account', actorAccountId: accountId, targetType: 'slug', targetId: pageId }, trx);
      }

      // An expired hold is reclaimed by updating its row: the name is the key.
      const key = slug.toLowerCase();
      const held = await trx.selectFrom('pages.slugs').select('slugKey').where('slugKey', '=', key).executeTakeFirst();
      if (held) {
        await trx
          .updateTable('pages.slugs')
          .set({ slug, pageId, role: 'primary', claimedAt: new Date(), releasedAt: null, blockedUntil: null })
          .where('slugKey', '=', key)
          .execute();
      } else {
        await trx.insertInto('pages.slugs').values({ slugKey: key, slug, pageId, role: 'primary' }).execute();
      }

      // The clock starts at the first change, not at the first name.
      if (current) await trx.updateTable('pages.pages').set({ slugChangedAt: new Date() }).where('id', '=', pageId).execute();

      await this.audit.record(
        context,
        { action: current ? 'slug.changed' : 'slug.claimed', actorType: 'account', actorAccountId: accountId, targetType: 'slug', targetId: pageId },
        trx,
      );
      return { status: 'ok' as const, slug };
    });
  }
}
