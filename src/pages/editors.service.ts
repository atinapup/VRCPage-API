import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Audit } from '../audit/audit.js';
import type { RequestContext } from '../common/request-context.js';
import { AppConfig } from '../config/app-config.js';
import { Database } from '../database/database.js';
import type { DB } from '../database/database.types.js';
import type { Editor, GroupEditors, Invitation } from './editors.dto.js';
import { PagesService } from './pages.service.js';

/*
 * Editors: the people an owner asks to help run a group's page.
 *
 * An owner invites by vrc.page name, because that is the only name they have
 * for each other here; nobody is searched for by email. The invitation waits
 * until it is answered, and only then is a seat taken.
 *
 *   owner   claims the group, names its page, chooses who can see it, and
 *           who edits it
 *   editor  changes the page's own links; nothing else
 *
 * Seats and waiting invitations together are capped by
 * groups.editors.max_per_group, counted again when an invitation is
 * accepted, because the owner may have filled the group in the meantime.
 * A group somebody edits never counts toward their own groups.max_per_user.
 */

export type InviteResult =
  | { status: 'ok'; editor: Editor }
  | { status: 'not_found' }
  | { status: 'not_allowed' }
  /** No page has that name, or it is a group's rather than a person's. */
  | { status: 'no_such_page' }
  | { status: 'yourself' }
  | { status: 'already_editor' }
  | { status: 'already_invited' }
  | { status: 'limit_reached' };

export type AnswerResult = { status: 'ok' } | { status: 'not_found' } | { status: 'limit_reached' };

export type RemoveResult = { status: 'ok' } | { status: 'not_found' } | { status: 'not_allowed' };

@Injectable()
export class EditorsService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly audit: Audit,
    private readonly pages: PagesService,
  ) {}

  private max(): Promise<number> {
    return this.db.setting<number>('groups.editors.max_per_group');
  }

  /**
   * How one account appears to another: the VRChat name and page they have
   * made public to the world anyway, and nothing else. Never an email.
   */
  private async person(executor: Kysely<DB>, accountId: string): Promise<{ name: string | null; slug: string | null; iconUrl: string | null }> {
    const row = await executor
      .selectFrom('vrchat.users as u')
      .leftJoin('pages.pages as p', 'p.vrchatUserId', 'u.id')
      .leftJoin('vrchat.images as icon', 'icon.id', 'u.iconImageId')
      .select(['u.displayName', 'p.id as pageId', 'icon.sha256 as iconSha256'])
      .where('u.accountId', '=', accountId)
      .executeTakeFirst();
    if (!row) return { name: null, slug: null, iconUrl: null };

    const slug = row.pageId
      ? ((
          await executor
            .selectFrom('pages.slugs')
            .select('slug')
            .where('pageId', '=', row.pageId)
            .where('role', '=', 'primary')
            .executeTakeFirst()
        )?.slug ?? null)
      : null;
    return { name: row.displayName, slug, iconUrl: this.imageUrl(row.iconSha256) };
  }

  private imageUrl(sha256: Buffer | null): string | null {
    return sha256 && this.config.imagesBaseUrl ? `${this.config.imagesBaseUrl}/images/${sha256.toString('hex')}.webp` : null;
  }

  /** Seats taken plus invitations still waiting: what the cap counts. */
  private async taken(executor: Kysely<DB>, pageId: string): Promise<number> {
    const seats = await executor
      .selectFrom('pages.editors')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('pageId', '=', pageId)
      .executeTakeFirstOrThrow();
    const waiting = await executor
      .selectFrom('pages.editorInvites')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('pageId', '=', pageId)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    return Number(seats.count) + Number(waiting.count);
  }

  /** Who runs this group. Owners only: an editor has no say over the seats. */
  async list(accountId: string, pageId: string): Promise<GroupEditors | 'not_found' | 'not_allowed'> {
    const role = await this.pages.role(this.db, accountId, pageId);
    if (!role) return 'not_found';
    if (role !== 'owner') return 'not_allowed';

    const seats = await this.db.selectFrom('pages.editors').select(['accountId', 'addedAt']).where('pageId', '=', pageId).orderBy('addedAt').execute();
    const waiting = await this.db
      .selectFrom('pages.editorInvites')
      .select(['id', 'invitedAccountId', 'createdAt'])
      .where('pageId', '=', pageId)
      .where('status', '=', 'pending')
      .orderBy('createdAt')
      .execute();

    const editors: Editor[] = [];
    for (const seat of seats) {
      editors.push({ id: seat.accountId, ...(await this.person(this.db, seat.accountId)), since: seat.addedAt.toISOString(), pending: false });
    }
    for (const invite of waiting) {
      editors.push({ id: invite.id, ...(await this.person(this.db, invite.invitedAccountId)), since: invite.createdAt.toISOString(), pending: true });
    }
    return { editors, max: await this.max() };
  }

  /** Ask the person at a vrc.page name to help run this group. */
  async invite(context: RequestContext, accountId: string, pageId: string, name: string): Promise<InviteResult> {
    const max = await this.max();

    return this.db.write({ requestId: context.requestId, type: 'account', accountId }, async (trx) => {
      const role = await this.pages.role(trx, accountId, pageId);
      if (!role) return { status: 'not_found' as const };
      if (role !== 'owner') return { status: 'not_allowed' as const };

      // The name is how people know each other here, so it is what an
      // invitation is addressed to. Only a person's page has somebody behind it.
      const found = await trx
        .selectFrom('pages.slugs as s')
        .innerJoin('pages.pages as p', 'p.id', 's.pageId')
        .innerJoin('vrchat.users as u', 'u.id', 'p.vrchatUserId')
        .select(['u.accountId'])
        .where('s.slugKey', '=', name.trim().toLowerCase())
        .where('p.kind', '=', 'user')
        .executeTakeFirst();
      if (!found) return { status: 'no_such_page' as const };
      if (found.accountId === accountId) return { status: 'yourself' as const };

      const seat = await trx.selectFrom('pages.editors').select('accountId').where('pageId', '=', pageId).where('accountId', '=', found.accountId).executeTakeFirst();
      if (seat) return { status: 'already_editor' as const };
      const waiting = await trx
        .selectFrom('pages.editorInvites')
        .select('id')
        .where('pageId', '=', pageId)
        .where('invitedAccountId', '=', found.accountId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (waiting) return { status: 'already_invited' as const };
      if ((await this.taken(trx, pageId)) >= max) return { status: 'limit_reached' as const };

      const invite = await trx
        .insertInto('pages.editorInvites')
        .values({ pageId, invitedAccountId: found.accountId, invitedByAccountId: accountId })
        .returning(['id', 'createdAt'])
        .executeTakeFirstOrThrow();
      await this.audit.record(
        context,
        { action: 'group.invite_sent', actorType: 'account', actorAccountId: accountId, targetType: 'invite', targetId: invite.id },
        trx,
      );

      return {
        status: 'ok' as const,
        editor: { id: invite.id, ...(await this.person(trx, found.accountId)), since: invite.createdAt.toISOString(), pending: true },
      };
    });
  }

  /** Invitations waiting for this account's answer. */
  async invitations(accountId: string): Promise<Invitation[]> {
    const rows = await this.db
      .selectFrom('pages.editorInvites as i')
      .innerJoin('pages.pages as p', 'p.id', 'i.pageId')
      .innerJoin('vrchat.groups as g', 'g.id', 'p.vrchatGroupId')
      .leftJoin('vrchat.images as icon', 'icon.id', 'g.iconImageId')
      .select(['i.id', 'i.pageId', 'i.invitedByAccountId', 'i.createdAt', 'g.name', 'g.memberCount', 'icon.sha256 as iconSha256'])
      .where('i.invitedAccountId', '=', accountId)
      .where('i.status', '=', 'pending')
      .orderBy('i.createdAt')
      .execute();

    const invitations: Invitation[] = [];
    for (const row of rows) {
      const slug = await this.db
        .selectFrom('pages.slugs')
        .select('slug')
        .where('pageId', '=', row.pageId)
        .where('role', '=', 'primary')
        .executeTakeFirst();
      invitations.push({
        id: row.id,
        groupName: row.name,
        groupSlug: slug?.slug ?? null,
        groupIconUrl: this.imageUrl(row.iconSha256),
        memberCount: row.memberCount,
        invitedBy: (await this.person(this.db, row.invitedByAccountId)).name,
        sentAt: row.createdAt.toISOString(),
      });
    }
    return invitations;
  }

  /**
   * Answer an invitation. Accepting counts the seats again, because the owner
   * may have filled the group while this one waited; the invitation stays
   * open in that case, so it can be accepted once a seat comes free.
   */
  async answer(context: RequestContext, accountId: string, inviteId: string, answer: 'accept' | 'decline'): Promise<AnswerResult> {
    const max = await this.max();

    return this.db.write({ requestId: context.requestId, type: 'account', accountId }, async (trx) => {
      const invite = await trx
        .selectFrom('pages.editorInvites')
        .select(['id', 'pageId'])
        .where('id', '=', inviteId)
        .where('invitedAccountId', '=', accountId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (!invite) return { status: 'not_found' as const };

      if (answer === 'decline') {
        await trx.updateTable('pages.editorInvites').set({ status: 'declined', respondedAt: new Date() }).where('id', '=', invite.id).execute();
        await this.audit.record(
          context,
          { action: 'group.invite_declined', actorType: 'account', actorAccountId: accountId, targetType: 'invite', targetId: invite.id },
          trx,
        );
        return { status: 'ok' as const };
      }

      const seat = await trx.selectFrom('pages.editors').select('accountId').where('pageId', '=', invite.pageId).where('accountId', '=', accountId).executeTakeFirst();
      if (!seat) {
        // This invitation is one of the waiting ones the cap counts, so it
        // does not stand in its own way.
        if ((await this.taken(trx, invite.pageId)) > max) return { status: 'limit_reached' as const };
        await trx.insertInto('pages.editors').values({ pageId: invite.pageId, accountId }).execute();
      }
      await trx.updateTable('pages.editorInvites').set({ status: 'accepted', respondedAt: new Date() }).where('id', '=', invite.id).execute();
      await this.audit.record(
        context,
        { action: 'group.invite_accepted', actorType: 'account', actorAccountId: accountId, targetType: 'invite', targetId: invite.id },
        trx,
      );
      return { status: 'ok' as const };
    });
  }

  /**
   * Take one row off the list, whichever kind it is: an invitation taken
   * back, an editor removed, or an editor leaving. The screen shows seats and
   * waiting invitations as one list, so it asks in one way too.
   *
   * Leaving is always allowed, so nobody is kept on a page they want no part
   * of. The group and its page are untouched either way.
   */
  async dismiss(context: RequestContext, accountId: string, pageId: string, id: string): Promise<RemoveResult> {
    return this.db.write({ requestId: context.requestId, type: 'account', accountId }, async (trx) => {
      const role = await this.pages.role(trx, accountId, pageId);
      if (!role) return { status: 'not_found' as const };
      const leaving = id === accountId;
      if (role !== 'owner' && !leaving) return { status: 'not_allowed' as const };

      if (!leaving) {
        const invite = await trx
          .updateTable('pages.editorInvites')
          .set({ status: 'revoked', respondedAt: new Date() })
          .where('id', '=', id)
          .where('pageId', '=', pageId)
          .where('status', '=', 'pending')
          .returning('id')
          .executeTakeFirst();
        if (invite) {
          await this.audit.record(
            context,
            { action: 'group.invite_revoked', actorType: 'account', actorAccountId: accountId, targetType: 'invite', targetId: invite.id },
            trx,
          );
          return { status: 'ok' as const };
        }
      }

      const seat = await trx.deleteFrom('pages.editors').where('pageId', '=', pageId).where('accountId', '=', id).returning('accountId').executeTakeFirst();
      if (!seat) return { status: 'not_found' as const };

      await this.audit.record(
        context,
        {
          action: leaving ? 'group.editor_left' : 'group.editor_removed',
          actorType: 'account',
          actorAccountId: accountId,
          targetType: 'page',
          targetId: pageId,
        },
        trx,
      );
      return { status: 'ok' as const };
    });
  }
}
