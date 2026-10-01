import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Audit } from '../audit/audit.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/database.js';
import type { DB } from '../database/database.types.js';
import { type Pictures, VRChatImages } from './images.js';
import { VRChatReader } from './reader.js';
import type { ReadFailure, ReadResult, VRChatGroup, VRChatUser } from './types.js';

/*
 * Proving someone controls a VRChat account or group, Section 4.
 *
 * vrc.page issues a one-time code, the person pastes it where only they can
 * write — their own bio, or the description of a group they own — and "Check
 * now" reads it back. Nobody ever hands over a VRChat password: control of
 * the text is the proof.
 *
 *   code        vrcpage- and six characters with no 0/O or 1/I/L
 *   lifetime    15 minutes, bound to one account and one VRChat id
 *   checks      8 at most, then the code is spent and a new one is needed
 *   cooldown    60 seconds between checks
 *   match       anywhere in the text, case insensitive
 *
 * A group is refused unless VRChat says the claimer owns it and it is not
 * private, both when the code is issued and again when it matches: a group
 * handed over or hidden in between never becomes somebody else's page.
 *
 * Reads go through VRChatReader, which spends them from the verification
 * lane. Only two things here read at all: issuing a group's code, and one
 * press of "Check now". A person's code is issued without a read, so their
 * first check has VRChat's once-a-minute turn to itself rather than waiting
 * behind the read that issued it; their name arrives with the match.
 * Reopening a group's claim shows the name kept from the first read.
 */

export type ClaimKind = 'user' | 'group';

export type ClaimSettings = {
  codeLength: number;
  codeAlphabet: string;
  ttlSeconds: number;
  maxChecks: number;
  checkCooldownSeconds: number;
};

/** Why a claim can't go ahead. The same answers whichever stage refuses it. */
export type Refusal =
  /** A VRChat account already connected here, or a group this account already added. */
  | 'already_connected'
  /** Connected or added by somebody else. */
  | 'taken'
  /** Groups only: there is no VRChat account to own one with yet. */
  | 'not_connected'
  | 'not_owner'
  | 'group_private'
  | 'limit_reached';

/** A claim waiting for its code to appear in VRChat. */
export type PendingClaim = {
  kind: ClaimKind;
  /** The usr_ or grp_ id being claimed. */
  targetId: string;
  /** Whose account, or which group, so nobody claims the wrong one. */
  displayName: string;
  code: string;
  /** ISO 8601. */
  expiresAt: string;
  checksLeft: number;
  /** Seconds until "Check now" works again; 0 when it does. */
  checkIn: number;
};

export type StartResult =
  | { status: 'ok'; claim: PendingClaim }
  | { status: 'refused'; reason: Refusal }
  | { status: 'not_found' }
  /** Too soon after this account's last read of VRChat. */
  | { status: 'cooldown'; wait: number }
  | { status: 'read_failed'; reason: ReadFailure; waitSeconds?: number };

export type CheckResult =
  | { status: 'matched'; pageId: string; displayName: string }
  | { status: 'no_match'; claim: PendingClaim }
  | { status: 'cooldown'; claim: PendingClaim }
  | { status: 'read_failed'; reason: ReadFailure; waitSeconds?: number; claim: PendingClaim }
  /** The code matched, but the claim still isn't allowed. */
  | { status: 'refused'; reason: Refusal }
  | { status: 'expired' }
  | { status: 'exhausted' }
  | { status: 'no_claim' };

/** One VRChat record, read the same way whichever kind it is. */
type Target = {
  id: string;
  /** A user's display name, or a group's name. */
  name: string;
  /** Where the code is looked for: the bio, or the description. */
  text: string;
  user?: VRChatUser;
  group?: VRChatGroup;
};

/** The trail reads differently for the two kinds, so each has its own names. */
const ACTIONS = {
  user: {
    started: 'link.code_generated',
    attempted: 'link.check_attempted',
    failed: 'link.check_failed',
    expired: 'link.code_expired',
    succeeded: 'link.succeeded',
    denied: 'link.denied_already_linked',
    target: 'vrchat_user',
  },
  group: {
    started: 'group.claim_started',
    attempted: 'group.check_attempted',
    failed: 'group.check_failed',
    expired: 'group.claim_expired',
    succeeded: 'group.claimed',
    denied: 'group.denied',
    target: 'vrchat_group',
  },
} as const;

@Injectable()
export class ClaimsService {
  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
    private readonly reader: VRChatReader,
    private readonly images: VRChatImages,
  ) {}

  private async settings(): Promise<ClaimSettings> {
    const [codeLength, codeAlphabet, ttlSeconds, maxChecks, checkCooldownSeconds] = await Promise.all([
      this.db.setting<number>('claim.code.length'),
      this.db.setting<string>('claim.code.alphabet'),
      this.db.setting<number>('claim.code.ttl_seconds'),
      this.db.setting<number>('claim.code.max_check_attempts'),
      this.db.setting<number>('claim.code.check_cooldown_seconds'),
    ]);
    return { codeLength, codeAlphabet, ttlSeconds, maxChecks, checkCooldownSeconds };
  }

  /** Drawn without modulo bias, so no character is likelier than another. */
  private code({ codeLength, codeAlphabet }: ClaimSettings): string {
    let out = '';
    while (out.length < codeLength) out += codeAlphabet[randomInt(codeAlphabet.length)];
    return `vrcpage-${out}`;
  }

  /**
   * One read from VRChat, spent from the verification lane.
   *
   * Only ever called where a read is the point: issuing a code, and one press
   * of "Check now". Showing a claim that already exists reads nothing, because
   * a name on a screen is not worth a call from a budget of 1440 a day.
   */
  private async read(kind: ClaimKind, id: string): Promise<ReadResult<Target>> {
    if (kind === 'user') {
      const result = await this.reader.getUser('verification', id);
      return result.ok
        ? { ok: true, value: { id: result.value.id, name: result.value.displayName, text: result.value.bio, user: result.value } }
        : result;
    }
    const result = await this.reader.getGroup('verification', id);
    return result.ok ? { ok: true, value: { id: result.value.id, name: result.value.name, text: result.value.description, group: result.value } } : result;
  }

  /** The account's own VRChat account, which is what owns a group here. */
  private connection(executor: Kysely<DB>, accountId: string) {
    return executor.selectFrom('vrchat.users').select('id').where('accountId', '=', accountId).executeTakeFirst();
  }

  /**
   * Whether this account may claim this target, asked of the database and of
   * what VRChat itself just said, never of the caller. It runs before a code
   * is issued and again when one matches, because either side can change
   * while a code sits in a bio.
   */
  private async refusal(executor: Kysely<DB>, accountId: string, kind: ClaimKind, target: Target): Promise<Refusal | null> {
    const mine = await this.connection(executor, accountId);

    if (kind === 'user') {
      if (mine) return 'already_connected';
      const elsewhere = await executor.selectFrom('vrchat.users').select('id').where('id', '=', target.id).executeTakeFirst();
      return elsewhere ? 'taken' : null;
    }

    if (!mine) return 'not_connected';
    const claimed = await executor.selectFrom('vrchat.groups').select('claimedByVrchatUserId').where('id', '=', target.id).executeTakeFirst();
    if (claimed) return claimed.claimedByVrchatUserId === mine.id ? 'already_connected' : 'taken';
    if (target.group!.privacy !== 'default') return 'group_private';
    if (target.group!.ownerId !== mine.id) return 'not_owner';

    const max = await this.db.setting<number>('groups.max_per_user');
    const owned = await executor
      .selectFrom('vrchat.groups')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('claimedByVrchatUserId', '=', mine.id)
      .executeTakeFirstOrThrow();
    return Number(owned.count) >= max ? 'limit_reached' : null;
  }

  private view(
    row: {
      targetKind: ClaimKind;
      vrchatUserId: string | null;
      vrchatGroupId: string | null;
      code: string;
      expiresAt: Date;
      checkCount: number;
      lastCheckedAt: Date | null;
    },
    displayName: string,
    settings: ClaimSettings,
  ): PendingClaim {
    const since = row.lastCheckedAt ? (Date.now() - row.lastCheckedAt.getTime()) / 1000 : Infinity;
    return {
      kind: row.targetKind,
      targetId: (row.targetKind === 'user' ? row.vrchatUserId : row.vrchatGroupId)!,
      displayName,
      code: row.code,
      expiresAt: row.expiresAt.toISOString(),
      checksLeft: Math.max(0, settings.maxChecks - row.checkCount),
      checkIn: Math.max(0, Math.ceil(settings.checkCooldownSeconds - since)),
    };
  }

  private openClaim(accountId: string, kind: ClaimKind) {
    return this.db
      .selectFrom('vrchat.claimCodes')
      .select(['id', 'targetKind', 'vrchatUserId', 'vrchatGroupId', 'code', 'expiresAt', 'checkCount', 'lastCheckedAt', 'displayName'])
      .where('accountId', '=', accountId)
      .where('targetKind', '=', kind)
      .where('status', '=', 'pending')
      .executeTakeFirst();
  }

  /**
   * Seconds this account must still wait before it may cost another read.
   *
   * Issuing a code and pressing "Check now" both read VRChat, so both are
   * counted here: whichever happened last starts the wait.
   */
  private async sinceLastRead(accountId: string, kind: ClaimKind, settings: ClaimSettings): Promise<number> {
    const row = await this.db
      .selectFrom('vrchat.claimCodes')
      .select((eb) => eb.fn.max(eb.fn('greatest', ['createdAt', eb.fn.coalesce('lastCheckedAt', 'createdAt')])).as('last'))
      .where('accountId', '=', accountId)
      .where('targetKind', '=', kind)
      .executeTakeFirst();
    const last = row?.last ? new Date(row.last as unknown as string).getTime() : 0;
    return Math.max(0, Math.ceil((last + settings.checkCooldownSeconds * 1000 - Date.now()) / 1000));
  }

  /** The account's open claim of this kind, or null when there is none or it has run out. */
  async pending(accountId: string, kind: ClaimKind): Promise<PendingClaim | null> {
    const settings = await this.settings();
    const row = await this.openClaim(accountId, kind);
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now() || row.checkCount >= settings.maxChecks) return null;

    const targetId = (kind === 'user' ? row.vrchatUserId : row.vrchatGroupId)!;
    return this.view(row, row.displayName ?? targetId, settings);
  }

  /**
   * Issue a code. A group is read first, so its owner and privacy are known
   * before anyone edits its description. A person is not: everything that
   * could refuse them is in the database, and VRChat is asked once, by the
   * first check, instead of twice in a row a minute apart. Asking again for
   * the same one returns the code already issued, so reloading never breaks
   * a code that has been pasted into VRChat.
   */
  async start(context: RequestContext, accountId: string, kind: ClaimKind, targetId: string): Promise<StartResult> {
    const settings = await this.settings();
    const actions = ACTIONS[kind];

    // Nothing is read from VRChat for an account that cannot claim anything.
    const connected = await this.connection(this.db, accountId);
    if (kind === 'user' && connected) return { status: 'refused', reason: 'already_connected' };
    if (kind === 'group' && !connected) return { status: 'refused', reason: 'not_connected' };

    // Asking again for the claim already open reads nothing: the answer is
    // the code that is already pasted into VRChat somewhere.
    const open = await this.pending(accountId, kind);
    if (open && open.targetId === targetId) return { status: 'ok', claim: open };

    let target: Target | null = null;
    if (kind === 'group') {
      // Issuing a group's code costs a read, exactly like a check does, so it
      // waits the same 60 seconds. Without this, giving up a claim and
      // starting another in a loop would spend the whole verification lane
      // for everybody.
      const wait = await this.sinceLastRead(accountId, kind, settings);
      if (wait > 0) return { status: 'cooldown', wait };

      const read = await this.read(kind, targetId);
      if (!read.ok) return read.reason === 'not_found' ? { status: 'not_found' } : { status: 'read_failed', reason: read.reason, waitSeconds: read.waitSeconds };
      target = read.value;
    }

    // A person can only be refused for being connected already, here or to
    // another account, which the database answers on its own.
    const refusal = target
      ? await this.refusal(this.db, accountId, kind, target)
      : (await this.db.selectFrom('vrchat.users').select('id').where('id', '=', targetId).executeTakeFirst())
        ? ('taken' as const)
        : null;
    if (refusal) {
      if (refusal === 'taken') {
        await this.audit.record(context, {
          action: actions.denied,
          result: 'denied',
          actorType: 'account',
          actorAccountId: accountId,
          targetType: actions.target,
          targetId,
          security: true,
        });
      }
      return { status: 'refused', reason: refusal };
    }

    const claim = await this.db.write({ requestId: context.requestId, type: 'account', accountId }, async (trx) => {
      // Only one code of a kind may be open per account, so a code for
      // another target is given up here rather than left to expire.
      await trx
        .updateTable('vrchat.claimCodes')
        .set({ status: 'cancelled', resolvedAt: new Date() })
        .where('accountId', '=', accountId)
        .where('targetKind', '=', kind)
        .where('status', '=', 'pending')
        .execute();

      const row = await trx
        .insertInto('vrchat.claimCodes')
        .values({
          accountId,
          targetKind: kind,
          vrchatUserId: kind === 'user' ? targetId : null,
          vrchatGroupId: kind === 'group' ? targetId : null,
          code: this.code(settings),
          expiresAt: new Date(Date.now() + settings.ttlSeconds * 1000),
          // A group's name, kept from its one read, so reopening the claim
          // costs nothing. A person's arrives with the match.
          displayName: target?.name.slice(0, 200) || null,
        })
        .returning(['id', 'targetKind', 'vrchatUserId', 'vrchatGroupId', 'code', 'expiresAt', 'checkCount', 'lastCheckedAt', 'displayName'])
        .executeTakeFirstOrThrow();

      await this.audit.record(
        context,
        { action: actions.started, actorType: 'account', actorAccountId: accountId, targetType: actions.target, targetId, security: true },
        trx,
      );
      return row;
    });

    return { status: 'ok', claim: this.view(claim, target?.name ?? targetId, settings) };
  }

  async cancel(context: RequestContext, accountId: string, kind: ClaimKind): Promise<void> {
    await this.db.write({ requestId: context.requestId, type: 'account', accountId }, async (trx) => {
      await trx
        .updateTable('vrchat.claimCodes')
        .set({ status: 'cancelled', resolvedAt: new Date() })
        .where('accountId', '=', accountId)
        .where('targetKind', '=', kind)
        .where('status', '=', 'pending')
        .execute();
    });
  }

  /**
   * One press of "Check now": at most one read from VRChat.
   *
   * The order is deliberate. Expiry, the attempt limit and the cooldown are
   * all checked first, so pressing too early never spends a read. The
   * cooldown starts before the read, so two quick presses can't both go out.
   * A read that fails for VRChat's own reasons doesn't use up one of the
   * eight checks, because it said nothing about the text.
   */
  async check(context: RequestContext, accountId: string, kind: ClaimKind): Promise<CheckResult> {
    const settings = await this.settings();
    const actions = ACTIONS[kind];
    const actor = { requestId: context.requestId, type: 'account' as const, accountId };

    const row = await this.openClaim(accountId, kind);
    if (!row) return { status: 'no_claim' };
    const targetId = (kind === 'user' ? row.vrchatUserId : row.vrchatGroupId)!;

    const resolve = (status: 'expired' | 'exhausted') =>
      this.db.write(actor, async (trx) => {
        await trx.updateTable('vrchat.claimCodes').set({ status, resolvedAt: new Date() }).where('id', '=', row.id).execute();
        await this.audit.record(
          context,
          {
            action: status === 'expired' ? actions.expired : actions.failed,
            result: 'failure',
            actorType: 'account',
            actorAccountId: accountId,
            metadata: { reason: status },
            security: true,
          },
          trx,
        );
      });

    if (row.expiresAt.getTime() <= Date.now()) {
      await resolve('expired');
      return { status: 'expired' };
    }
    if (row.checkCount >= settings.maxChecks) {
      await resolve('exhausted');
      return { status: 'exhausted' };
    }
    const waited = row.lastCheckedAt ? (Date.now() - row.lastCheckedAt.getTime()) / 1000 : Infinity;
    if (waited < settings.checkCooldownSeconds) {
      // Too soon is not a reason to ask VRChat anything.
      return { status: 'cooldown', claim: this.view(row, row.displayName ?? targetId, settings) };
    }

    // The cooldown starts now, before the read.
    await this.db.write(actor, async (trx) => {
      await trx.updateTable('vrchat.claimCodes').set({ lastCheckedAt: new Date() }).where('id', '=', row.id).execute();
    });
    const read = await this.read(kind, targetId);
    const checked = { ...row, lastCheckedAt: new Date() };

    if (!read.ok && read.reason === 'busy') {
      // Nothing was asked: another read had VRChat's turn. The cooldown this
      // press started is handed back, so the next try can go as soon as the
      // turn frees rather than a whole minute from now.
      await this.db.write(actor, async (trx) => {
        await trx.updateTable('vrchat.claimCodes').set({ lastCheckedAt: row.lastCheckedAt }).where('id', '=', row.id).execute();
      });
      const claim = this.view(row, row.displayName ?? targetId, settings);
      return { status: 'read_failed', reason: 'busy', waitSeconds: read.waitSeconds, claim: { ...claim, checkIn: Math.max(claim.checkIn, read.waitSeconds ?? 0) } };
    }
    if (!read.ok) {
      await this.audit.record(context, {
        action: actions.attempted,
        result: 'failure',
        actorType: 'account',
        actorAccountId: accountId,
        targetType: actions.target,
        targetId,
        metadata: { reason: read.reason },
      });
      return { status: 'read_failed', reason: read.reason, waitSeconds: read.waitSeconds, claim: this.view(checked, targetId, settings) };
    }

    const target = read.value;
    const matched = target.text.toLowerCase().includes(row.code.toLowerCase());
    const count = row.checkCount + 1;

    if (!matched) {
      await this.db.write(actor, async (trx) => {
        await trx
          .updateTable('vrchat.claimCodes')
          .set(count >= settings.maxChecks ? { checkCount: count, status: 'exhausted', resolvedAt: new Date() } : { checkCount: count })
          .where('id', '=', row.id)
          .execute();
        await this.audit.record(
          context,
          {
            action: actions.failed,
            result: 'failure',
            actorType: 'account',
            actorAccountId: accountId,
            targetType: actions.target,
            targetId,
            metadata: { checksLeft: settings.maxChecks - count },
          },
          trx,
        );
      });
      if (count >= settings.maxChecks) return { status: 'exhausted' };
      return { status: 'no_match', claim: this.view({ ...checked, checkCount: count }, target.name, settings) };
    }

    // The code matched. Its pictures are fetched first, outside the
    // transaction, because a download can take seconds. Claiming is then one
    // transaction: the VRChat record and its pictures, the page it publishes,
    // and the code being spent.
    const pictures = await this.images.fetch(target.user ?? target.group!);
    return this.db.write(actor, async (trx) => {
      const refusal = await this.refusal(trx, accountId, kind, target);
      if (refusal) {
        await trx
          .updateTable('vrchat.claimCodes')
          .set({ checkCount: count, status: 'denied', deniedReason: refusal, resolvedAt: new Date() })
          .where('id', '=', row.id)
          .execute();
        await this.audit.record(
          context,
          {
            action: actions.denied,
            result: 'denied',
            actorType: 'account',
            actorAccountId: accountId,
            targetType: actions.target,
            targetId,
            metadata: { reason: refusal },
            security: true,
          },
          trx,
        );
        return { status: 'refused' as const, reason: refusal };
      }

      const pageId = await this.install(trx, accountId, kind, target, pictures);
      await trx
        .updateTable('vrchat.claimCodes')
        .set({ checkCount: count, status: 'succeeded', resolvedAt: new Date() })
        .where('id', '=', row.id)
        .execute();

      await this.audit.record(
        context,
        { action: actions.succeeded, actorType: 'account', actorAccountId: accountId, targetType: actions.target, targetId, security: true },
        trx,
      );
      return { status: 'matched' as const, pageId, displayName: target.name };
    });
  }

  /** The VRChat record and the page it publishes. Its name comes after. */
  private async install(trx: Kysely<DB>, accountId: string, kind: ClaimKind, target: Target, pictures: Pictures): Promise<string> {
    const images = await this.images.columns(trx, pictures);
    if (kind === 'user') {
      const user = target.user!;
      await trx
        .insertInto('vrchat.users')
        .values({
          id: user.id,
          accountId,
          displayName: user.displayName,
          bio: user.bio,
          bioLinks: user.bioLinks,
          pronouns: user.pronouns,
          // Unknown until the first refresh reads it (src/vrchat/api.ts).
          status: user.status ?? 'offline',
          statusDescription: user.statusDescription,
          isAgeVerified: user.isAgeVerified,
          trustRank: user.trustRank,
          representedGroupId: user.representedGroup?.id ?? null,
          representedGroupName: user.representedGroup?.name ?? null,
          languages: user.languages,
          ...images,
          fetchedAt: new Date(),
        })
        .execute();
      const page = await trx.insertInto('pages.pages').values({ kind: 'user', vrchatUserId: user.id }).returning('id').executeTakeFirstOrThrow();
      return page.id;
    }

    const group = target.group!;
    const mine = await trx.selectFrom('vrchat.users').select('id').where('accountId', '=', accountId).executeTakeFirstOrThrow();
    await trx
      .insertInto('vrchat.groups')
      .values({
        id: group.id,
        claimedByVrchatUserId: mine.id,
        ownerVrchatUserId: group.ownerId,
        name: group.name,
        shortCode: group.shortCode,
        discriminator: group.discriminator,
        description: group.description,
        rules: group.rules,
        links: group.links,
        languages: group.languages,
        memberCount: group.memberCount,
        isVerified: group.isVerified,
        privacy: group.privacy,
        ...images,
        fetchedAt: new Date(),
      })
      .execute();
    const page = await trx.insertInto('pages.pages').values({ kind: 'group', vrchatGroupId: group.id }).returning('id').executeTakeFirstOrThrow();
    return page.id;
  }
}
