import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import { Database } from '../database/database.js';
import type {
  Dashboard,
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

/** Reads of pages and the dashboard. Every answer is built from the database, per request. */
@Injectable()
export class PagesService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

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
      group: row.representedGroupId && row.representedGroupName ? { id: row.representedGroupId, name: row.representedGroupName } : null,
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
    return page ? { pageId: row.id, slug: await this.primarySlug(row.id), page } : null;
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
    return page ? { pageId, slug: await this.primarySlug(pageId), role, page } : null;
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
}
