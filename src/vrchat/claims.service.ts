import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { Audit } from '../audit/audit.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/database.js';
import type { DB } from '../database/database.types.js';
import { environment } from '../config/app-config.js';
import { fakeReader, type FakeGroup, type FakeUser, type ReadResult } from './fake-reader.js';

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
 * Until the rate-limited VRChat client exists, development reads the test
 * records in fake-reader.ts. Production has nothing to read with yet, and
 * says so rather than pretending.
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
  | { status: 'read_failed'; reason: 'rate_limited' | 'unavailable' };

export type CheckResult =
  | { status: 'matched'; pageId: string }
  | { status: 'no_match'; claim: PendingClaim }
  | { status: 'cooldown'; claim: PendingClaim }
  | { status: 'read_failed'; reason: 'not_found' | 'rate_limited' | 'unavailable'; claim: PendingClaim }
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
  user?: FakeUser;
  group?: FakeGroup;
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

  /** One read from VRChat. Development reads the test records. */
  private read(kind: ClaimKind, id: string): ReadResult<Target> {
    if (environment !== 'development') return { ok: false, reason: 'unavailable' };
    if (kind === 'user') {
      const result = fakeReader.getUser(id);
      return result.ok
        ? { ok: true, value: { id: result.value.id, name: result.value.displayName, text: result.value.bio, user: result.value } }
        : result;
    }
    const result = fakeReader.getGroup(id);
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
      .select(['id', 'targetKind', 'vrchatUserId', 'vrchatGroupId', 'code', 'expiresAt', 'checkCount', 'lastCheckedAt'])
      .where('accountId', '=', accountId)
      .where('targetKind', '=', kind)
      .where('status', '=', 'pending')
      .executeTakeFirst();
  }

  /** The account's open claim of this kind, or null when there is none or it has run out. */
  async pending(accountId: string, kind: ClaimKind): Promise<PendingClaim | null> {
    const settings = await this.settings();
    const row = await this.openClaim(accountId, kind);
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now() || row.checkCount >= settings.maxChecks) return null;

    const targetId = (kind === 'user' ? row.vrchatUserId : row.vrchatGroupId)!;
    const read = this.read(kind, targetId);
    return this.view(row, read.ok ? read.value.name : targetId, settings);
  }

  /**
   * Issue a code, after reading the target once so the person can see what
   * they are about to claim. Asking again for the same one returns the code
   * already issued, so reloading never breaks a code that has been pasted
   * into VRChat.
   */
  async start(context: RequestContext, accountId: string, kind: ClaimKind, targetId: string): Promise<StartResult> {
    const settings = await this.settings();
    const actions = ACTIONS[kind];

    // Nothing is read from VRChat for an account that cannot claim anything.
    const connected = await this.connection(this.db, accountId);
    if (kind === 'user' && connected) return { status: 'refused', reason: 'already_connected' };
    if (kind === 'group' && !connected) return { status: 'refused', reason: 'not_connected' };

    const read = this.read(kind, targetId);
    if (!read.ok) return read.reason === 'not_found' ? { status: 'not_found' } : { status: 'read_failed', reason: read.reason };
    const target = read.value;

    const refusal = await this.refusal(this.db, accountId, kind, target);
    if (refusal) {
      if (refusal === 'taken') {
        await this.audit.record(context, {
          action: actions.denied,
          result: 'denied',
          actorType: 'account',
          actorAccountId: accountId,
          targetType: actions.target,
          targetId: target.id,
          security: true,
        });
      }
      return { status: 'refused', reason: refusal };
    }

    const existing = await this.pending(accountId, kind);
    if (existing && existing.targetId === target.id) return { status: 'ok', claim: existing };

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
          vrchatUserId: kind === 'user' ? target.id : null,
          vrchatGroupId: kind === 'group' ? target.id : null,
          code: this.code(settings),
          expiresAt: new Date(Date.now() + settings.ttlSeconds * 1000),
        })
        .returning(['id', 'targetKind', 'vrchatUserId', 'vrchatGroupId', 'code', 'expiresAt', 'checkCount', 'lastCheckedAt'])
        .executeTakeFirstOrThrow();

      await this.audit.record(
        context,
        { action: actions.started, actorType: 'account', actorAccountId: accountId, targetType: actions.target, targetId: target.id, security: true },
        trx,
      );
      return row;
    });

    return { status: 'ok', claim: this.view(claim, target.name, settings) };
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
      const read = this.read(kind, targetId);
      return { status: 'cooldown', claim: this.view(row, read.ok ? read.value.name : targetId, settings) };
    }

    // The cooldown starts now, before the read.
    await this.db.write(actor, async (trx) => {
      await trx.updateTable('vrchat.claimCodes').set({ lastCheckedAt: new Date() }).where('id', '=', row.id).execute();
    });
    const read = this.read(kind, targetId);
    const checked = { ...row, lastCheckedAt: new Date() };

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
      return { status: 'read_failed', reason: read.reason, claim: this.view(checked, targetId, settings) };
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

    // The code matched. Claiming is one transaction: the VRChat record, the
    // page it publishes, and the code being spent.
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

      const pageId = await this.install(trx, accountId, kind, target);
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
      return { status: 'matched' as const, pageId };
    });
  }

  /** The VRChat record and the page it publishes. Its name comes after. */
  private async install(trx: Kysely<DB>, accountId: string, kind: ClaimKind, target: Target): Promise<string> {
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
          status: user.status,
          isAgeVerified: user.isAgeVerified,
          trustRank: user.trustRank,
          representedGroupId: user.representedGroup?.id ?? null,
          representedGroupName: user.representedGroup?.name ?? null,
          languages: user.languages,
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
        fetchedAt: new Date(),
      })
      .execute();
    const page = await trx.insertInto('pages.pages').values({ kind: 'group', vrchatGroupId: group.id }).returning('id').executeTakeFirstOrThrow();
    return page.id;
  }
}
