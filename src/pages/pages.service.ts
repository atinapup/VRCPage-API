import { Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { Audit } from '../audit/audit.js';
import type { RequestContext } from '../common/request-context.js';
import { AppConfig } from '../config/app-config.js';
import { Database } from '../database/database.js';
import { MailService } from '../mail/mail.service.js';
import type { DB } from '../database/database.types.js';
import { imagePath } from '../vrchat/images.js';
import { checkLink, linkIdentity } from './links.js';
import { liveStreams } from './streams.js';
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

/** VRChat's links are VRChat's to moderate; ours alone go through links.custom.blocked_hosts. */
const NOTHING_BLOCKED: ReadonlySet<string> = new Set();

/**
 * What an account may do with a page. Anything else is not its page at all.
 * An admin may do everything an owner may, on every page, with no waits.
 */
export type PageRole = 'owner' | 'editor' | 'admin';

/** Staff roles, from auth.account_roles. */
export type AccountRole = 'admin' | 'moderator' | 'partner';

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
    private readonly mail: MailService,
  ) {}

  /**
   * This account's standing on a page, from the database rather than anything
   * the caller said: it owns its own page through the VRChat connection, owns
   * a group through the connection that claimed it, and edits one by its seat.
   * Null for every other page, including ones that don't exist. An admin is
   * 'admin' on every page, its own included, so its exemptions follow it.
   */
  async role(executor: Kysely<DB>, accountId: string, pageId: string): Promise<PageRole | null> {
    const row = await executor
      .selectFrom('pages.pages as p')
      .leftJoin('vrchat.users as u', 'u.id', 'p.vrchatUserId')
      .leftJoin('vrchat.groups as g', 'g.id', 'p.vrchatGroupId')
      .leftJoin('vrchat.users as claimer', 'claimer.id', 'g.claimedByVrchatUserId')
      .leftJoin('pages.editors as e', (join) => join.onRef('e.pageId', '=', 'p.id').on('e.accountId', '=', accountId))
      .leftJoin('auth.accountRoles as r', (join) => join.on('r.accountId', '=', accountId).on('r.role', '=', 'admin'))
      .select((eb) => [
        eb('u.accountId', '=', accountId).as('ownsUserPage'),
        eb('claimer.accountId', '=', accountId).as('ownsGroup'),
        eb('e.accountId', 'is not', null).as('edits'),
        eb('r.accountId', 'is not', null).as('admin'),
      ])
      .where('p.id', '=', pageId)
      .executeTakeFirst();
    if (!row) return null;
    if (row.admin) return 'admin';
    if (row.ownsUserPage || row.ownsGroup) return 'owner';
    return row.edits ? 'editor' : null;
  }

  /** The staff roles this account holds. */
  async roles(accountId: string): Promise<AccountRole[]> {
    const rows = await this.db.selectFrom('auth.accountRoles').select('role').where('accountId', '=', accountId).orderBy('role').execute();
    return rows.map((row) => row.role);
  }

  async isAdmin(accountId: string): Promise<boolean> {
    return (await this.roles(accountId)).includes('admin');
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

  /**
   * VRChat's links first, then the page's own, in order. VRChat's are stored
   * as VRChat sent them, so they pass the same check as ours on the way out:
   * only plain https ever reaches a page. Hidden ones are marked, not left
   * out: the owner's own lists show them, and publicPage() leaves them out.
   */
  private async links(pageId: string, fromVRChat: string[]): Promise<PageLink[]> {
    const [own, hidden] = await Promise.all([
      this.db.selectFrom('pages.links').select(['url', 'label', 'isAdult', 'isHidden']).where('pageId', '=', pageId).orderBy('position').execute(),
      this.db.selectFrom('pages.hiddenLinks').select('identity').where('pageId', '=', pageId).execute(),
    ]);
    const hiddenVRChat = new Set(hidden.map((row) => row.identity));
    const checked = fromVRChat.map((raw) => checkLink(raw, NOTHING_BLOCKED)).filter((link) => link.status === 'ok');
    return [
      ...checked.map(({ url }) => ({ url, label: null, source: 'vrchat' as const, adult: false, hidden: hiddenVRChat.has(linkIdentity(url)) })),
      ...own.map((link) => ({ url: link.url, label: link.label, source: 'vrcpage' as const, adult: link.isAdult, hidden: link.isHidden })),
    ];
  }

  /**
   * The links a page's visitors see, in order, and whether visitors can open
   * the page at all. Null for a page that doesn't exist. Lighter than
   * userPage()/groupPage() for page stats, which only need the links.
   */
  async visibleLinks(pageId: string): Promise<{ open: boolean; links: PageLink[] } | null> {
    const row = await this.db
      .selectFrom('pages.pages as p')
      .leftJoin('vrchat.users as u', 'u.id', 'p.vrchatUserId')
      .leftJoin('vrchat.groups as g', 'g.id', 'p.vrchatGroupId')
      .select(['p.visibility', 'p.hiddenAt', 'u.bioLinks', 'g.links'])
      .where('p.id', '=', pageId)
      .executeTakeFirst();
    if (!row) return null;
    const links = await this.links(pageId, row.bioLinks ?? row.links ?? []);
    return { open: row.visibility !== 'private' && row.hiddenAt === null, links: links.filter((link) => !link.hidden) };
  }

  async userPage(pageId: string): Promise<UserPage | null> {
    const row = await this.db
      .selectFrom('pages.pages as p')
      .innerJoin('vrchat.users as u', 'u.id', 'p.vrchatUserId')
      .leftJoin('vrchat.images as icon', 'icon.id', 'u.iconImageId')
      .leftJoin('vrchat.images as banner', 'banner.id', 'u.bannerImageId')
      .leftJoin('vrchat.images as ownBanner', 'ownBanner.id', 'p.bannerImageId')
      .leftJoin('vrchat.images as ownPicture', 'ownPicture.id', 'p.pictureImageId')
      .select([
        'p.visibility',
        'p.socialsEnabled',
        'p.accent',
        'ownBanner.sha256 as ownBannerSha256',
        'ownPicture.sha256 as ownPictureSha256',
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
      // The page's own picture and banner win: the owner chose them.
      bannerUrl: imagePath(row.ownBannerSha256 ?? row.bannerSha256),
      avatarUrl: imagePath(row.ownPictureSha256 ?? row.iconSha256),
      verifiedAt: row.connectedAt.toISOString(),
      lastRefreshedAt: row.fetchedAt.toISOString(),
      visibility: row.visibility,
      socialsEnabled: row.socialsEnabled,
      accent: row.accent,
      ownBannerUrl: imagePath(row.ownBannerSha256),
      ownPictureUrl: imagePath(row.ownPictureSha256),
    };
  }

  async groupPage(pageId: string): Promise<GroupPage | null> {
    const row = await this.db
      .selectFrom('pages.pages as p')
      .innerJoin('vrchat.groups as g', 'g.id', 'p.vrchatGroupId')
      .innerJoin('vrchat.users as claimer', 'claimer.id', 'g.claimedByVrchatUserId')
      .leftJoin('pages.pages as ownerPage', 'ownerPage.vrchatUserId', 'claimer.id')
      .leftJoin('vrchat.images as icon', 'icon.id', 'g.iconImageId')
      .leftJoin('vrchat.images as banner', 'banner.id', 'g.bannerImageId')
      .leftJoin('vrchat.images as ownBanner', 'ownBanner.id', 'p.bannerImageId')
      .leftJoin('vrchat.images as ownPicture', 'ownPicture.id', 'p.pictureImageId')
      .select([
        'p.visibility',
        'p.socialsEnabled',
        'p.accent',
        'ownBanner.sha256 as ownBannerSha256',
        'ownPicture.sha256 as ownPictureSha256',
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
      iconUrl: imagePath(row.ownPictureSha256 ?? row.iconSha256),
      // The page's own picture and banner win: the owner chose them.
      bannerUrl: imagePath(row.ownBannerSha256 ?? row.bannerSha256),
      owner: { displayName: row.ownerName, slug: ownerPublic ? await this.primarySlug(row.ownerPageId!) : null },
      verifiedAt: row.claimedAt.toISOString(),
      lastRefreshedAt: row.fetchedAt.toISOString(),
      visibility: row.visibility,
      socialsEnabled: row.socialsEnabled,
      accent: row.accent,
      ownBannerUrl: imagePath(row.ownBannerSha256),
      ownPictureUrl: imagePath(row.ownPictureSha256),
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
      .select(['p.id', 'p.kind', 'p.visibility', 'p.hiddenAt', 's.role', 's.isRedirect'])
      .where('s.slugKey', '=', slug.toLowerCase())
      .executeTakeFirst();
    if (!found || found.visibility === 'private' || found.hiddenAt !== null) return null;

    const primary = await this.primarySlug(found.id);
    if (!primary) return null;
    const alias = found.role === 'alias';
    const redirect = alias && found.isRedirect;

    // Hidden links stay with the owner: nothing about them leaves here.
    if (found.kind === 'user') {
      const user = await this.userPage(found.id);
      if (!user) return null;
      user.links = user.links.filter((link) => !link.hidden);
      return { pageId: found.id, kind: 'user', slug: primary, alias, redirect, user, live: await liveStreams(user.links) };
    }
    const group = await this.groupPage(found.id);
    if (!group) return null;
    group.links = group.links.filter((link) => !link.hidden);
    return { pageId: found.id, kind: 'group', slug: primary, alias, redirect, group, live: await liveStreams(group.links) };
  }

  /**
   * One of the pages an admin picked for the home page, at random, or null
   * when none is picked. Only public user pages count: the home page would
   * otherwise publish an unlisted page's address.
   */
  async showcasePage(): Promise<PublicPage | null> {
    const found = await this.db
      .selectFrom('pages.pages as p')
      .innerJoin('pages.slugs as s', (join) => join.onRef('s.pageId', '=', 'p.id').on('s.role', '=', 'primary'))
      .select(['p.id', 's.slug'])
      .where('p.isShowcase', '=', true)
      .where('p.kind', '=', 'user')
      .where('p.visibility', '=', 'public')
      .where('p.hiddenAt', 'is', null)
      .orderBy(sql`random()`)
      .limit(1)
      .executeTakeFirst();
    if (!found) return null;
    const user = await this.userPage(found.id);
    if (!user) return null;
    user.links = user.links.filter((link) => !link.hidden);
    return { pageId: found.id, kind: 'user', slug: found.slug, alias: false, redirect: false, user, live: [] };
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
    return page ? { pageId: row.id, slug: await this.primarySlug(row.id), ...(await this.waits(accountId, row.id)), page } : null;
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
   * so a screen never offers something only to refuse it. An admin never waits.
   */
  private async waits(accountId: string, pageId: string): Promise<{ nameChangeableAt: string | null; refreshableAt: string | null }> {
    if (await this.isAdmin(accountId)) return { nameChangeableAt: null, refreshableAt: null };
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
    return page ? { pageId, slug: await this.primarySlug(pageId), role, ...(await this.waits(accountId, pageId)), page } : null;
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
      roles: await this.roles(accountId),
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
      if (role === 'editor') return 'not_allowed';

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
   *
   * An admin may also take a short name, one that looks like impersonation,
   * or one still held. Reserved names stay refused: they are the site's own
   * routes, so a page there would never be reached.
   */
  async nameAvailability(name: string, pageId: string | null = null, admin = false): Promise<NameAvailability> {
    const settings = await this.nameSettings();
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    const shape = { minLength: admin ? 1 : settings.minLength, maxLength: settings.maxLength };

    if (trimmed.length < shape.minLength) return { status: 'too_short', ...shape };
    if (trimmed.length > settings.maxLength) return { status: 'too_long', ...shape };
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return { status: 'invalid', ...shape };
    if (settings.reserved.includes(key)) return { status: 'reserved', ...shape };
    if (!admin && settings.blocked.some((word) => key.includes(word.toLowerCase()))) return { status: 'impersonation', ...shape };

    const row = await this.db.selectFrom('pages.slugs').select(['pageId', 'blockedUntil']).where('slugKey', '=', key).executeTakeFirst();
    if (!row) return { status: 'available', ...shape };
    if (row.pageId) return { status: row.pageId === pageId ? 'yours' : 'taken', ...shape };
    const held = !admin && row.blockedUntil !== null && row.blockedUntil.getTime() > Date.now();
    return { status: held ? 'held' : 'available', ...shape };
  }

  /**
   * Put a name on a page, as its primary or as an alias. A name used before
   * is a row already (the name is the key), whether it is held or is one of
   * this page's aliases, so taking it updates that row. The caller has
   * checked that the name is free. Names are stored lowercase, however they
   * were typed, so an address is only ever written one way.
   */
  async takeName(trx: Kysely<DB>, pageId: string, slug: string, role: 'primary' | 'alias', isRedirect = true): Promise<void> {
    const key = slug.toLowerCase();
    const existing = await trx.selectFrom('pages.slugs').select('slugKey').where('slugKey', '=', key).executeTakeFirst();
    if (existing) {
      await trx
        .updateTable('pages.slugs')
        .set({ slug: key, pageId, role, isRedirect, claimedAt: new Date(), releasedAt: null, blockedUntil: null })
        .where('slugKey', '=', key)
        .execute();
    } else {
      await trx.insertInto('pages.slugs').values({ slugKey: key, slug: key, pageId, role, isRedirect }).execute();
    }
  }

  /** Stop a name pointing at its page, and hold it for slug.tombstone_days so nobody can pass as whoever had it. */
  async releaseName(trx: Kysely<DB>, slugKey: string, tombstoneDays: number): Promise<void> {
    await trx
      .updateTable('pages.slugs')
      .set({ pageId: null, releasedAt: new Date(), blockedUntil: new Date(Date.now() + tombstoneDays * 24 * 60 * 60 * 1000) })
      .where('slugKey', '=', slugKey)
      .execute();
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
   * for slug.tombstone_days. Names are lowercase, so a name typed with
   * capitals is the same name.
   */
  async setName(
    context: RequestContext,
    accountId: string,
    pageId: string,
    name: string,
  ): Promise<SetNameResult> {
    const settings = await this.nameSettings();
    // Set inside the transaction, acted on after it commits: an email that
    // fails to queue must not undo the rename it is about.
    let first = false;

    const result = await this.db.write({ requestId: context.requestId, type: 'account', accountId }, async (trx) => {
      // Nobody is told anything about a page, or a name for it, before they
      // are shown to run that page.
      const role = await this.role(trx, accountId, pageId);
      if (!role) return { status: 'not_found' as const };
      if (role === 'editor') return { status: 'not_allowed' as const };
      const admin = role === 'admin';

      const availability = await this.nameAvailability(name, pageId, admin);
      if (availability.status !== 'available' && availability.status !== 'yours') {
        return { status: 'unavailable' as const, availability };
      }

      const slug = name.trim().toLowerCase();
      const page = await trx.selectFrom('pages.pages').select(['slugChangedAt']).where('id', '=', pageId).executeTakeFirstOrThrow();
      const current = await trx
        .selectFrom('pages.slugs')
        .select('slugKey')
        .where('pageId', '=', pageId)
        .where('role', '=', 'primary')
        .executeTakeFirst();

      // Its own name again: nothing to change, so no hold and no cooldown.
      if (current && current.slugKey === slug) return { status: 'ok' as const, slug };

      const waitUntil = admin ? null : this.nextRename(page.slugChangedAt, settings.cooldownDays);
      if (waitUntil) return { status: 'cooldown' as const, availableAt: waitUntil };

      if (current) {
        await this.releaseName(trx, current.slugKey, settings.tombstoneDays);
        await this.audit.record(context, { action: 'slug.released', actorType: 'account', actorAccountId: accountId, targetType: 'slug', targetId: pageId }, trx);
      }
      await this.takeName(trx, pageId, slug, 'primary');

      // The clock starts at the first change, not at the first name.
      if (current) await trx.updateTable('pages.pages').set({ slugChangedAt: new Date() }).where('id', '=', pageId).execute();

      await this.audit.record(
        context,
        { action: current ? 'slug.changed' : 'slug.claimed', actorType: 'account', actorAccountId: accountId, targetType: 'slug', targetId: pageId },
        trx,
      );
      first = !current;
      return { status: 'ok' as const, slug };
    });

    // Only the first name is worth an email: it is the moment the page goes
    // live. A later rename is something the person is already looking at.
    if (result.status === 'ok' && first) await this.announceName(accountId, result.slug, settings.cooldownDays);
    return result;
  }

  /** Tell the owner their page is live, if they still want email about their pages. */
  private async announceName(accountId: string, slug: string, cooldownDays: number): Promise<void> {
    const account = await this.db.selectFrom('auth.accounts').select('email').where('id', '=', accountId).executeTakeFirst();
    if (!account) return;
    await this.mail.enqueue({
      to: account.email,
      accountId,
      template: 'name_claimed',
      props: { slug, pageUrl: `${this.config.webOrigin}/${slug}`, cooldownDays },
      category: 'notification',
      preference: 'notifyPageChanges',
      idempotencyKey: `name:${accountId}:${slug}`,
    });
  }
}
