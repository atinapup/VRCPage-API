import { Injectable } from '@nestjs/common';
import { Audit, type AuditEvent } from '../audit/audit.js';
import { AuthService, EMAIL_SHAPE, mask } from '../auth/auth.service.js';
import type { RequestContext } from '../common/request-context.js';
import { Database, type WriteActor } from '../database/database.js';
import { MailService } from '../mail/mail.service.js';
import { type AccountRole, PagesService } from '../pages/pages.service.js';
import { imagePath } from '../vrchat/images.js';
import type { AdminAccount, AdminAccountList, AdminAccountRow, AdminPage, AdminPageList, AdminPageRow } from './admin.dto.js';

/** One screen of a list. */
const PAGE_SIZE = 50;

/** Postgres' answer when a unique index refuses a row. */
const UNIQUE_VIOLATION = '23505';

/** Text for ILIKE, matching anywhere, with the pattern characters taken literally. */
function contains(query: string): string {
  return `%${query.replace(/[\\%_]/g, '\\$&')}%`;
}

export type AccountPatchResult = 'ok' | 'not_found' | 'invalid_email' | 'email_taken';
export type AliasResult = { status: 'ok' } | { status: 'not_found' } | { status: 'unavailable'; reason: string };

/*
 * What only an admin can do: look up any account or page, and change what
 * the database would otherwise need SQL for. Every write names the admin as a
 * staff actor, so row history and audit.events both say who did it.
 *
 * Changes an owner could make themselves (a page's name, visibility, links,
 * refresh, editors) are not here: PagesService.role() makes an admin an owner
 * of every page, so those go through the owner's own endpoints.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
    private readonly auth: AuthService,
    private readonly mail: MailService,
    private readonly pages: PagesService,
  ) {}

  private actor(context: RequestContext, adminId: string): WriteActor {
    return { requestId: context.requestId, type: 'staff', accountId: adminId };
  }

  private event(adminId: string, event: Omit<AuditEvent, 'actorType' | 'actorAccountId' | 'security'>): AuditEvent {
    return { ...event, actorType: 'staff', actorAccountId: adminId, security: true };
  }

  /* Accounts --------------------------------------------------------------- */

  async accounts(query: string, before: string | null): Promise<AdminAccountList> {
    let select = this.db
      .selectFrom('auth.accounts as a')
      .leftJoin('vrchat.users as u', 'u.accountId', 'a.id')
      .leftJoin('pages.pages as p', 'p.vrchatUserId', 'u.id')
      .leftJoin('pages.slugs as s', (join) => join.onRef('s.pageId', '=', 'p.id').on('s.role', '=', 'primary'))
      .leftJoin('vrchat.images as icon', 'icon.id', 'u.iconImageId')
      .select(['a.id', 'a.email', 'a.createdAt', 'u.id as vrchatId', 'u.displayName', 'p.id as pageId', 's.slug', 'icon.sha256 as iconSha256'])
      .orderBy('a.id', 'desc')
      .limit(PAGE_SIZE + 1);
    if (before) select = select.where('a.id', '<', before);
    if (query) {
      const pattern = contains(query);
      select = select.where((eb) => eb.or([eb('a.email', 'ilike', pattern), eb('u.displayName', 'ilike', pattern), eb('s.slug', 'ilike', pattern)]));
    }
    const rows = await select.execute();
    const shown = rows.slice(0, PAGE_SIZE);
    const ids = shown.map((row) => row.id);
    const vrchatIds = shown.flatMap((row) => (row.vrchatId ? [row.vrchatId] : []));

    const roles = ids.length ? await this.db.selectFrom('auth.accountRoles').select(['accountId', 'role']).where('accountId', 'in', ids).orderBy('role').execute() : [];
    const groups = vrchatIds.length
      ? await this.db
          .selectFrom('vrchat.groups')
          .select((eb) => ['claimedByVrchatUserId', eb.fn.countAll<number>().as('count')])
          .where('claimedByVrchatUserId', 'in', vrchatIds)
          .groupBy('claimedByVrchatUserId')
          .execute()
      : [];

    const accounts: AdminAccountRow[] = shown.map((row) => ({
      id: row.id,
      email: row.email,
      createdAt: row.createdAt.toISOString(),
      roles: roles.filter((role) => role.accountId === row.id).map((role) => role.role),
      vrchatName: row.displayName,
      vrchatId: row.vrchatId,
      avatarUrl: imagePath(row.iconSha256),
      pageId: row.pageId,
      slug: row.slug,
      groups: Number(groups.find((group) => group.claimedByVrchatUserId === row.vrchatId)?.count ?? 0),
    }));
    return { accounts, next: rows.length > PAGE_SIZE ? shown[shown.length - 1].id : null };
  }

  async account(accountId: string): Promise<AdminAccount | null> {
    const account = await this.db
      .selectFrom('auth.accounts')
      .select(['id', 'email', 'name', 'isEmailVerified', 'createdAt'])
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!account) return null;

    const [roles, identities, sessions, vrchat, owned, edited] = await Promise.all([
      this.pages.roles(accountId),
      this.db.selectFrom('auth.identities').select('providerId').where('accountId', '=', accountId).orderBy('providerId').execute(),
      this.db
        .selectFrom('auth.sessions')
        .select(['id', 'createdAt', 'expiresAt', 'ipAddress', 'userAgent'])
        .where('accountId', '=', accountId)
        .where('expiresAt', '>', new Date())
        .orderBy('createdAt', 'desc')
        .execute(),
      this.db.selectFrom('vrchat.users').select(['id', 'displayName', 'connectedAt']).where('accountId', '=', accountId).executeTakeFirst(),
      this.pageRows((select) => select.where('o.ownerAccountId', '=', accountId)),
      this.db.selectFrom('pages.editors').select('pageId').where('accountId', '=', accountId).execute(),
    ]);
    const editedIds = edited.map((row) => row.pageId);

    return {
      id: account.id,
      email: account.email,
      name: account.name,
      emailVerified: account.isEmailVerified,
      createdAt: account.createdAt.toISOString(),
      roles,
      providers: identities.map((identity) => identity.providerId).filter((provider) => provider !== 'credential'),
      sessions: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        ip: session.ipAddress || null,
        userAgent: session.userAgent || null,
      })),
      vrchat: vrchat ? { id: vrchat.id, displayName: vrchat.displayName, connectedAt: vrchat.connectedAt.toISOString() } : null,
      // Its own page first, then its groups, oldest first.
      pages: owned.sort((a, b) => (a.kind === b.kind ? a.createdAt.localeCompare(b.createdAt) : a.kind === 'user' ? -1 : 1)),
      editing: editedIds.length ? await this.pageRows((select) => select.where('o.pageId', 'in', editedIds)) : [],
    };
  }

  /** Change an account's email address or name. Better Auth owns auth.accounts, so the change goes through it. */
  async updateAccount(context: RequestContext, adminId: string, accountId: string, patch: { email?: string; name?: string }): Promise<AccountPatchResult> {
    const internal = (await this.auth.auth.$context).internalAdapter;
    const account = await internal.findUserById(accountId);
    if (!account) return 'not_found';

    const change: { email?: string; name?: string } = {};
    if (patch.name !== undefined && patch.name.trim() !== account.name) change.name = patch.name.trim();
    if (patch.email !== undefined) {
      const email = patch.email.trim().toLowerCase();
      if (!EMAIL_SHAPE.test(email) || email.length > 254) return 'invalid_email';
      if (email !== account.email) {
        if (await internal.findUserByEmail(email)) return 'email_taken';
        change.email = email;
      }
    }
    if (!change.email && change.name === undefined) return 'ok';

    try {
      await internal.updateUser(accountId, change);
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return 'email_taken';
      throw error;
    }
    await this.audit.record(
      context,
      this.event(adminId, {
        action: 'admin.account_updated',
        targetType: 'account',
        targetId: accountId,
        metadata: { email: change.email !== undefined, name: change.name !== undefined },
      }),
    );
    // The old address hears about it, the same as when its owner changes it.
    if (change.email) {
      await this.mail.enqueue({
        to: account.email,
        accountId,
        template: 'email_changed',
        props: { newEmail: mask(change.email) },
        category: 'transactional',
      });
    }
    return 'ok';
  }

  /** Grant or revoke a staff role. False when there is no such account. */
  async setRole(context: RequestContext, adminId: string, accountId: string, role: AccountRole, granted: boolean): Promise<boolean> {
    return this.db.write(this.actor(context, adminId), async (trx) => {
      const account = await trx.selectFrom('auth.accounts').select('id').where('id', '=', accountId).executeTakeFirst();
      if (!account) return false;
      if (granted) {
        await trx
          .insertInto('auth.accountRoles')
          .values({ accountId, role, grantedBy: adminId })
          .onConflict((conflict) => conflict.columns(['accountId', 'role']).doNothing())
          .execute();
      } else {
        await trx.deleteFrom('auth.accountRoles').where('accountId', '=', accountId).where('role', '=', role).execute();
      }
      await this.audit.record(
        context,
        this.event(adminId, { action: granted ? 'admin.role_granted' : 'admin.role_revoked', targetType: 'account', targetId: accountId, metadata: { role } }),
        trx,
      );
      return true;
    });
  }

  /** End every session the account has, so it has to sign in again everywhere. */
  async signOutEverywhere(context: RequestContext, adminId: string, accountId: string): Promise<number> {
    return this.db.write(this.actor(context, adminId), async (trx) => {
      const ended = await trx.deleteFrom('auth.sessions').where('accountId', '=', accountId).returning('id').execute();
      await this.audit.record(
        context,
        this.event(adminId, { action: 'admin.sessions_revoked', targetType: 'account', targetId: accountId, metadata: { count: ended.length } }),
        trx,
      );
      return ended.length;
    });
  }

  /** Disconnect the account's VRChat user. The database takes its page and groups with it, and holds their names. */
  async disconnectVRChat(context: RequestContext, adminId: string, accountId: string): Promise<boolean> {
    return this.db.write(this.actor(context, adminId), async (trx) => {
      const connection = await trx.deleteFrom('vrchat.users').where('accountId', '=', accountId).returning('id').executeTakeFirst();
      if (!connection) return false;
      await this.audit.record(context, this.event(adminId, { action: 'admin.vrchat_disconnected', targetType: 'vrchat_user', targetId: connection.id }), trx);
      return true;
    });
  }

  /** Delete an account. The auth.accounts row cascades to everything it owns (docs/database.md). */
  async deleteAccount(context: RequestContext, adminId: string, accountId: string): Promise<boolean> {
    const internal = (await this.auth.auth.$context).internalAdapter;
    if (!(await internal.findUserById(accountId))) return false;
    await internal.deleteUser(accountId);
    await this.audit.record(context, this.event(adminId, { action: 'admin.account_deleted', targetType: 'account', targetId: accountId }));
    return true;
  }

  /* Pages ------------------------------------------------------------------ */

  /** Rows of pages.page_overview, with each page's icon. */
  private async pageRows(
    filter: (
      select: ReturnType<AdminService['overview']>,
    ) => ReturnType<AdminService['overview']>,
  ): Promise<AdminPageRow[]> {
    const rows = await filter(this.overview()).execute();
    return rows.map((row) => ({
      id: row.pageId!,
      kind: row.kind!,
      name: row.displayName ?? '',
      slug: row.primarySlug,
      visibility: row.visibility!,
      hidden: row.isHidden ?? false,
      vrchatId: row.vrchatId!,
      iconUrl: imagePath(row.userIcon ?? row.groupIcon),
      ownerAccountId: row.ownerAccountId!,
      ownerEmail: row.ownerEmail ?? '',
      createdAt: row.createdAt!.toISOString(),
    }));
  }

  private overview() {
    return this.db
      .selectFrom('pages.pageOverview as o')
      .innerJoin('pages.pages as p', 'p.id', 'o.pageId')
      .leftJoin('vrchat.users as u', 'u.id', 'p.vrchatUserId')
      .leftJoin('vrchat.groups as g', 'g.id', 'p.vrchatGroupId')
      .leftJoin('vrchat.images as ui', 'ui.id', 'u.iconImageId')
      .leftJoin('vrchat.images as gi', 'gi.id', 'g.iconImageId')
      .select([
        'o.pageId',
        'o.kind',
        'o.displayName',
        'o.primarySlug',
        'o.visibility',
        'o.isHidden',
        'o.vrchatId',
        'o.ownerAccountId',
        'o.ownerEmail',
        'o.createdAt',
        'ui.sha256 as userIcon',
        'gi.sha256 as groupIcon',
      ]);
  }

  async pageList(query: string, before: string | null): Promise<AdminPageList> {
    const rows = await this.pageRows((select) => {
      let filtered = select.orderBy('o.pageId', 'desc').limit(PAGE_SIZE + 1);
      if (before) filtered = filtered.where('o.pageId', '<', before);
      if (query) {
        const pattern = contains(query);
        filtered = filtered.where((eb) =>
          eb.or([
            eb('o.primarySlug', 'ilike', pattern),
            eb('o.displayName', 'ilike', pattern),
            eb('o.ownerEmail', 'ilike', pattern),
            // Aliases find their page too.
            eb.exists(eb.selectFrom('pages.slugs as a').select('a.slugKey').whereRef('a.pageId', '=', 'o.pageId').where('a.slug', 'ilike', pattern)),
          ]),
        );
      }
      return filtered;
    });
    const shown = rows.slice(0, PAGE_SIZE);
    return { pages: shown, next: rows.length > PAGE_SIZE ? shown[shown.length - 1].id : null };
  }

  async page(pageId: string): Promise<AdminPage | null> {
    const [row] = await this.pageRows((select) => select.where('o.pageId', '=', pageId));
    if (!row) return null;
    const [state, aliases] = await Promise.all([
      this.db.selectFrom('pages.pages').select(['hiddenAt', 'hiddenReason']).where('id', '=', pageId).executeTakeFirstOrThrow(),
      this.db.selectFrom('pages.slugs').select(['slug', 'isRedirect']).where('pageId', '=', pageId).where('role', '=', 'alias').orderBy('claimedAt').execute(),
    ]);
    const page: AdminPage = {
      pageId,
      kind: row.kind,
      slug: row.slug,
      hidden: state.hiddenAt ? { at: state.hiddenAt.toISOString(), reason: state.hiddenReason ?? '' } : null,
      ownerAccountId: row.ownerAccountId,
      ownerEmail: row.ownerEmail,
      aliases: aliases.map((alias) => ({ slug: alias.slug, redirect: alias.isRedirect })),
    };
    if (row.kind === 'user') page.user = (await this.pages.userPage(pageId)) ?? undefined;
    else page.group = (await this.pages.groupPage(pageId)) ?? undefined;
    return page;
  }

  /** Take a page down, or put it back. A hidden page is the same 404 as a missing one, and its owner can't undo it. */
  async setHidden(context: RequestContext, adminId: string, pageId: string, reason: string | null): Promise<boolean> {
    return this.db.write(this.actor(context, adminId), async (trx) => {
      const page = await trx
        .updateTable('pages.pages')
        .set(reason ? { hiddenAt: new Date(), hiddenReason: reason, hiddenBy: adminId } : { hiddenAt: null, hiddenReason: null, hiddenBy: null })
        .where('id', '=', pageId)
        .returning('id')
        .executeTakeFirst();
      if (!page) return false;
      await this.audit.record(context, this.event(adminId, { action: reason ? 'admin.page_hidden' : 'admin.page_restored', targetType: 'page', targetId: pageId }), trx);
      return true;
    });
  }

  /** Give a page another name. It redirects to the page's own name, or shows the page at itself. */
  async addAlias(context: RequestContext, adminId: string, pageId: string, name: string, redirect: boolean): Promise<AliasResult> {
    const availability = await this.pages.nameAvailability(name, pageId, true);
    if (availability.status === 'yours') return { status: 'unavailable', reason: 'already this page’s' };
    if (availability.status !== 'available') return { status: 'unavailable', reason: availability.status };

    return this.db.write(this.actor(context, adminId), async (trx) => {
      const page = await trx.selectFrom('pages.pages').select('id').where('id', '=', pageId).executeTakeFirst();
      if (!page) return { status: 'not_found' as const };
      await this.pages.takeName(trx, pageId, name.trim(), 'alias', redirect);
      await this.audit.record(context, this.event(adminId, { action: 'admin.alias_added', targetType: 'slug', targetId: pageId, metadata: { redirect } }), trx);
      return { status: 'ok' as const };
    });
  }

  async setAliasRedirect(context: RequestContext, adminId: string, pageId: string, name: string, redirect: boolean): Promise<boolean> {
    return this.db.write(this.actor(context, adminId), async (trx) => {
      const alias = await trx
        .updateTable('pages.slugs')
        .set({ isRedirect: redirect })
        .where('slugKey', '=', name.toLowerCase())
        .where('pageId', '=', pageId)
        .where('role', '=', 'alias')
        .returning('slugKey')
        .executeTakeFirst();
      if (!alias) return false;
      await this.audit.record(context, this.event(adminId, { action: 'admin.alias_changed', targetType: 'slug', targetId: pageId, metadata: { redirect } }), trx);
      return true;
    });
  }

  /** Take an alias off its page. The name is held for slug.tombstone_days, like any other released name. */
  async removeAlias(context: RequestContext, adminId: string, pageId: string, name: string): Promise<boolean> {
    const tombstoneDays = await this.db.setting<number>('slug.tombstone_days');
    return this.db.write(this.actor(context, adminId), async (trx) => {
      const alias = await trx
        .selectFrom('pages.slugs')
        .select('slugKey')
        .where('slugKey', '=', name.toLowerCase())
        .where('pageId', '=', pageId)
        .where('role', '=', 'alias')
        .executeTakeFirst();
      if (!alias) return false;
      await this.pages.releaseName(trx, alias.slugKey, tombstoneDays);
      await this.audit.record(context, this.event(adminId, { action: 'admin.alias_removed', targetType: 'slug', targetId: pageId }), trx);
      return true;
    });
  }
}
