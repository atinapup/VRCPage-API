import { Injectable } from '@nestjs/common';
import { Audit } from '../audit/audit.js';
import type { RequestContext } from '../common/request-context.js';
import { environment } from '../config/app-config.js';
import { Database } from '../database/database.js';
import { fakeReader } from '../vrchat/fake-reader.js';
import { PagesService } from './pages.service.js';

/*
 * "Refresh from VRChat": an owner asking for their page to be read again now,
 * rather than waiting for its turn (spec section 3).
 *
 * Every read VRChat answers goes through vrchat.jobs, so a manual refresh is a
 * job in the manual lane. That table is also what the limits count: the wait
 * between two manual refreshes of one page (refresh.manual.cooldown_seconds)
 * and how many one account may ask for in a UTC day
 * (refresh.manual.daily_cap_per_account). Only one job per page may be open,
 * so two quick presses can't both go out. A read VRChat failed counts towards
 * neither, because it told nobody anything.
 *
 * A group is only ever published for its owner, and never while private. A
 * refresh that finds either has changed acts on it: a group handed to someone
 * else is unclaimed, and one made private is made private here too.
 *
 * Until the rate-limited VRChat client exists, development reads the test
 * records and runs the job on the spot. Production has nothing to read with
 * yet, and says so rather than queueing work nothing will do.
 */

export type RefreshResult =
  | { status: 'ok'; refreshedAt: string }
  | { status: 'not_found' }
  | { status: 'not_allowed' }
  | { status: 'cooldown'; wait: number }
  | { status: 'daily_limit'; cap: number }
  /** VRChat no longer has the account or group. */
  | { status: 'gone' }
  /** The group has another owner now, so its page went. */
  | { status: 'unclaimed' }
  | { status: 'unavailable' };

/** Postgres' answer when a unique index refuses a row. */
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class RefreshService {
  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
    private readonly pages: PagesService,
  ) {}

  private async settings() {
    const [cooldownSeconds, dailyCap, ownerOnly] = await Promise.all([
      this.db.setting<number>('refresh.manual.cooldown_seconds'),
      this.db.setting<number>('refresh.manual.daily_cap_per_account'),
      this.db.setting<boolean>('refresh.manual.owner_only'),
    ]);
    return { cooldownSeconds, dailyCap, ownerOnly };
  }

  async refresh(context: RequestContext, accountId: string, pageId: string): Promise<RefreshResult> {
    const settings = await this.settings();
    const role = await this.pages.role(this.db, accountId, pageId);
    if (!role) return { status: 'not_found' };
    if (role !== 'owner' && settings.ownerOnly) return { status: 'not_allowed' };
    if (environment !== 'development') return { status: 'unavailable' };

    const waitUntil = await this.pages.refreshableAt(pageId);
    if (waitUntil) return { status: 'cooldown', wait: Math.max(1, Math.ceil((Date.parse(waitUntil) - Date.now()) / 1000)) };

    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const today = await this.db
      .selectFrom('vrchat.jobs')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('requestedBy', '=', accountId)
      .where('lane', '=', 'manual')
      .where('status', '!=', 'failed')
      .where('createdAt', '>=', midnight)
      .executeTakeFirstOrThrow();
    if (Number(today.count) >= settings.dailyCap) return { status: 'daily_limit', cap: settings.dailyCap };

    const page = await this.db
      .selectFrom('pages.pages as p')
      .leftJoin('vrchat.groups as g', 'g.id', 'p.vrchatGroupId')
      .select(['p.kind', 'p.vrchatUserId', 'p.vrchatGroupId', 'g.claimedByVrchatUserId'])
      .where('p.id', '=', pageId)
      .executeTakeFirstOrThrow();

    // The job is taken before the read, so a second press finds it open.
    let jobId: string;
    try {
      const job = await this.db
        .insertInto('vrchat.jobs')
        .values({
          kind: page.kind === 'user' ? 'user_refresh' : 'group_refresh',
          lane: 'manual',
          pageId,
          requestedBy: accountId,
          status: 'running',
          startedAt: new Date(),
          attempts: 1,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      jobId = job.id;
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return { status: 'cooldown', wait: settings.cooldownSeconds };
      throw error;
    }

    const actor = { requestId: context.requestId, type: 'account' as const, accountId };
    const finish = (status: 'succeeded' | 'failed', error: string | null = null) =>
      this.db.updateTable('vrchat.jobs').set({ status, finishedAt: new Date(), error }).where('id', '=', jobId).execute();

    // One read, kept by kind so each branch below has its own shape.
    const userRead = page.kind === 'user' ? fakeReader.getUser(page.vrchatUserId!) : null;
    const groupRead = page.kind === 'group' ? fakeReader.getGroup(page.vrchatGroupId!) : null;
    const read = (userRead ?? groupRead)!;
    if (!read.ok) {
      await finish('failed', read.reason);
      if (read.reason !== 'not_found') return { status: 'unavailable' };
      await this.db.write(actor, async (trx) => {
        const set = { lastFetchError: 'not_found' as const, lastFetchErrorAt: new Date() };
        if (page.kind === 'user') await trx.updateTable('vrchat.users').set(set).where('id', '=', page.vrchatUserId!).execute();
        else await trx.updateTable('vrchat.groups').set(set).where('id', '=', page.vrchatGroupId!).execute();
      });
      return { status: 'gone' };
    }

    const now = new Date();
    const outcome = await this.db.write(actor, async (trx) => {
      if (userRead?.ok) {
        const value = userRead.value;
        await trx
          .updateTable('vrchat.users')
          .set({
            displayName: value.displayName,
            bio: value.bio,
            bioLinks: value.bioLinks,
            pronouns: value.pronouns,
            status: value.status,
            isAgeVerified: value.isAgeVerified,
            trustRank: value.trustRank,
            representedGroupId: value.representedGroup?.id ?? null,
            representedGroupName: value.representedGroup?.name ?? null,
            languages: value.languages,
            fetchedAt: now,
            lastFetchError: null,
            lastFetchErrorAt: null,
          })
          .where('id', '=', value.id)
          .execute();
        return 'ok' as const;
      }

      if (!groupRead?.ok) return 'ok' as const;
      const value = groupRead.value;

      // Handed to someone else: it stops being this claimer's page. The
      // database takes the page, its links and editors with it, and holds the
      // name so nobody can pick it up straight away.
      if (value.ownerId !== page.claimedByVrchatUserId) {
        await trx.deleteFrom('vrchat.groups').where('id', '=', value.id).execute();
        await this.audit.record(
          context,
          {
            action: 'group.unclaimed',
            actorType: 'account',
            actorAccountId: accountId,
            targetType: 'vrchat_group',
            targetId: value.id,
            metadata: { reason: 'owner_changed' },
            security: true,
          },
          trx,
        );
        return 'unclaimed' as const;
      }

      await trx
        .updateTable('vrchat.groups')
        .set({
          name: value.name,
          shortCode: value.shortCode,
          discriminator: value.discriminator,
          description: value.description,
          rules: value.rules,
          links: value.links,
          languages: value.languages,
          memberCount: value.memberCount,
          isVerified: value.isVerified,
          privacy: value.privacy,
          ownerVrchatUserId: value.ownerId,
          fetchedAt: now,
          lastFetchError: null,
          lastFetchErrorAt: null,
        })
        .where('id', '=', value.id)
        .execute();

      // A group made private on VRChat is not published here either. The
      // owner can open it up again once it is public there.
      if (value.privacy === 'private') {
        await trx.updateTable('pages.pages').set({ visibility: 'private' }).where('id', '=', pageId).execute();
      }
      return 'ok' as const;
    });

    await finish('succeeded');
    await this.audit.record(context, {
      action: 'profile.refresh_requested',
      actorType: 'account',
      actorAccountId: accountId,
      targetType: page.kind === 'user' ? 'profile' : 'group',
      targetId: pageId,
      metadata: { lane: 'manual' },
    });
    return outcome === 'unclaimed' ? { status: 'unclaimed' } : { status: 'ok', refreshedAt: now.toISOString() };
  }
}
