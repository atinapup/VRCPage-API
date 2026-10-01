import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { Audit } from '../audit/audit.js';
import type { RequestContext } from '../common/request-context.js';
import { Database } from '../database/database.js';
import { VRChatImages } from '../vrchat/images.js';
import { VRChatReader } from '../vrchat/reader.js';
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
 * The read itself goes through VRChatReader, from the manual lane. VRChat is
 * read at most once a minute site-wide, so a press that arrives while another
 * read holds the turn is queued: its job goes back to `queued` with run_after
 * set to when the turn frees, and drain() runs it then. Nobody's request is
 * held open for that minute; the answer says it is queued.
 *
 * A person's status, status line and trust rank are a second read (VRChat's
 * profile only gives them to the profile's owner; src/vrchat/api.ts), made
 * once the slot frees after the first. Nobody waits for it: the page has
 * them a minute or so after the refresh.
 */

export type RefreshResult =
  | { status: 'ok'; refreshedAt: string }
  /** VRChat's turn was taken, so the job waits in the queue and drain() runs it once the turn frees. */
  | { status: 'queued' }
  | { status: 'not_found' }
  | { status: 'not_allowed' }
  | { status: 'cooldown'; wait: number }
  | { status: 'daily_limit'; cap: number }
  /** VRChat no longer has the account or group. */
  | { status: 'gone' }
  /** The group has another owner now, so its page went. */
  | { status: 'unclaimed' }
  /** Nothing was asked of VRChat and nothing was queued: the lane is spent for today, or reads are paused. */
  | { status: 'busy'; wait: number }
  | { status: 'unavailable' };

/** Postgres' answer when a unique index refuses a row. */
const UNIQUE_VIOLATION = '23505';

/**
 * A refresh is one read and at most two picture downloads, each with its own
 * timeout, so one still running after this long is never coming back.
 */
const ABANDONED_AFTER_MS = 5 * 60 * 1000;

/** Tries at the status read, each once the slot frees, before leaving it to the next refresh. */
const STATUS_TRIES = 4;
/** A wait longer than this is a spent lane or a backoff, not a busy slot: not worth queueing or holding a timer for. */
const MAX_SLOT_WAIT_SECONDS = 300;

/**
 * How often the queue is checked for a refresh whose turn has come. Well
 * under the minute between reads, so a queued one goes out within seconds of
 * the turn freeing rather than up to a minute after.
 */
const DRAIN_INTERVAL_MS = 10_000;

@Injectable()
export class RefreshService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RefreshService.name);
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    private readonly db: Database,
    private readonly audit: Audit,
    private readonly pages: PagesService,
    private readonly reader: VRChatReader,
    private readonly images: VRChatImages,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.drain(), DRAIN_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async settings() {
    const [dailyCap, ownerOnly] = await Promise.all([
      this.db.setting<number>('refresh.manual.daily_cap_per_account'),
      this.db.setting<boolean>('refresh.manual.owner_only'),
    ]);
    return { dailyCap, ownerOnly };
  }

  async refresh(context: RequestContext, accountId: string, pageId: string): Promise<RefreshResult> {
    const settings = await this.settings();
    const role = await this.pages.role(this.db, accountId, pageId);
    if (!role) return { status: 'not_found' };
    if (role === 'editor' && settings.ownerOnly) return { status: 'not_allowed' };

    // An admin skips the page's wait and the daily cap. VRChat's own turn
    // (once a minute, site-wide) still applies below: it protects the account
    // every read is made with.
    if (role !== 'admin') {
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
    }

    const { kind } = await this.db.selectFrom('pages.pages').select('kind').where('id', '=', pageId).executeTakeFirstOrThrow();

    // A job still running after this long was abandoned: the process stopped
    // or threw mid-refresh. Nothing else will ever close it, and while it is
    // open the page can't be refreshed at all, so it is closed here.
    await this.db
      .updateTable('vrchat.jobs')
      .set({ status: 'failed', finishedAt: new Date(), error: 'abandoned' })
      .where('pageId', '=', pageId)
      .where('status', '=', 'running')
      .where('startedAt', '<', new Date(Date.now() - ABANDONED_AFTER_MS))
      .execute();

    // The job is taken before the read, so a second press finds it open.
    let jobId: string;
    try {
      const job = await this.db
        .insertInto('vrchat.jobs')
        .values({
          kind: kind === 'user' ? 'user_refresh' : 'group_refresh',
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
      // Another press is queued or being read right now, and refreshes the page for this one too.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) return { status: 'queued' };
      throw error;
    }

    return this.run(context, accountId, pageId, jobId);
  }

  /**
   * Run the next queued refresh whose turn has come, every DRAIN_INTERVAL_MS.
   * One per pass: there is one turn a minute, so a second would only be
   * queued again. SKIP LOCKED means two API processes never take the same
   * job, and the turn itself (vrchat.client_state) still decides who reads.
   *
   * ponytail: a fresh press can take the turn ahead of a queued job, which
   * then waits for the next one. Queue every press if that starts to bite.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const job = await this.db
        .updateTable('vrchat.jobs')
        .set((eb) => ({ status: 'running', startedAt: new Date(), attempts: eb('attempts', '+', 1) }))
        .where(
          'id',
          '=',
          this.db
            .selectFrom('vrchat.jobs')
            .select('id')
            .where('status', '=', 'queued')
            .where('kind', 'in', ['user_refresh', 'group_refresh'])
            .where('runAfter', '<=', new Date())
            .orderBy('priority')
            .orderBy('runAfter')
            .orderBy('id')
            .limit(1)
            .forUpdate()
            .skipLocked(),
        )
        .returning(['id', 'pageId', 'requestedBy'])
        .executeTakeFirst();
      if (!job) return;

      // The account that pressed it was deleted, and with it the reason to read.
      if (!job.requestedBy) {
        await this.db.updateTable('vrchat.jobs').set({ status: 'cancelled', finishedAt: new Date() }).where('id', '=', job.id).execute();
        return;
      }
      const context = { requestId: randomUUID(), ip: null, userAgent: null, headers: new Headers() };
      await this.run(context, job.requestedBy, job.pageId!, job.id);
    } catch (error) {
      this.logger.warn(`A queued refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.draining = false;
    }
  }

  /**
   * Read the page for a running job and store what came back. Whatever goes
   * wrong, the job is closed, or it would hold the page's one open slot until
   * it was found abandoned.
   */
  private async run(context: RequestContext, accountId: string, pageId: string, jobId: string): Promise<RefreshResult> {
    try {
      const page = await this.db
        .selectFrom('pages.pages as p')
        .leftJoin('vrchat.groups as g', 'g.id', 'p.vrchatGroupId')
        .select(['p.kind', 'p.vrchatUserId', 'p.vrchatGroupId', 'g.claimedByVrchatUserId'])
        .where('p.id', '=', pageId)
        .executeTakeFirstOrThrow();
      return await this.readAndStore(context, accountId, pageId, page, jobId);
    } catch (error) {
      await this.db
        .updateTable('vrchat.jobs')
        .set({ status: 'failed', finishedAt: new Date(), error: (error instanceof Error ? error.message : 'error').slice(0, 500) })
        .where('id', '=', jobId)
        .where('status', '=', 'running')
        .execute();
      throw error;
    }
  }

  private async readAndStore(
    context: RequestContext,
    accountId: string,
    pageId: string,
    page: { kind: 'user' | 'group'; vrchatUserId: string | null; vrchatGroupId: string | null; claimedByVrchatUserId: string | null },
    jobId: string,
  ): Promise<RefreshResult> {
    const actor = { requestId: context.requestId, type: 'account' as const, accountId };
    const finish = (status: 'succeeded' | 'failed', error: string | null = null) =>
      this.db.updateTable('vrchat.jobs').set({ status, finishedAt: new Date(), error }).where('id', '=', jobId).execute();

    // One read, kept by kind so each branch below has its own shape.
    const userRead = page.kind === 'user' ? await this.reader.getUser('manual', page.vrchatUserId!, jobId) : null;
    const groupRead = page.kind === 'group' ? await this.reader.getGroup('manual', page.vrchatGroupId!, jobId) : null;
    const read = (userRead ?? groupRead)!;
    if (!read.ok) {
      // Nothing was asked, so nothing was learned and nothing was spent. A
      // turn that frees soon is waited for in the queue. A longer wait is a
      // spent lane or a backoff: the job is closed, and the press can be made
      // again later.
      const wait = read.waitSeconds ?? 60;
      if (read.reason === 'busy' && wait <= MAX_SLOT_WAIT_SECONDS) {
        await this.db
          .updateTable('vrchat.jobs')
          .set({ status: 'queued', startedAt: null, runAfter: new Date(Date.now() + wait * 1000) })
          .where('id', '=', jobId)
          .execute();
        return { status: 'queued' };
      }
      await finish('failed', read.reason);
      if (read.reason === 'busy') return { status: 'busy', wait };
      if (read.reason !== 'not_found') return { status: 'unavailable' };
      await this.db.write(actor, async (trx) => {
        const set = { lastFetchError: 'not_found' as const, lastFetchErrorAt: new Date() };
        if (page.kind === 'user') await trx.updateTable('vrchat.users').set(set).where('id', '=', page.vrchatUserId!).execute();
        else await trx.updateTable('vrchat.groups').set(set).where('id', '=', page.vrchatGroupId!).execute();
      });
      return { status: 'gone' };
    }

    // Pictures are fetched before the transaction: a download can take seconds.
    const pictures = await this.images.fetch(read.value);
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
            // The profile only says these to its owner; readStatus() fills
            // them in from the user endpoint.
            ...(value.status ? { status: value.status, statusDescription: value.statusDescription } : {}),
            isAgeVerified: value.isAgeVerified,
            representedGroupId: value.representedGroup?.id ?? null,
            representedGroupName: value.representedGroup?.name ?? null,
            languages: value.languages,
            ...(await this.images.columns(trx, pictures)),
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
          ...(await this.images.columns(trx, pictures)),
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
    if (userRead?.ok) this.readStatus(page.vrchatUserId!);
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

  /**
   * The second read of a person's refresh: status, status line and trust
   * rank, from the manual lane like the first. Tried as soon as the slot is
   * free, which is about a minute after the first read took it.
   *
   * ponytail: an in-process timer, so a restart in that minute drops it and
   * the next refresh tries again. A queued job once there is a worker to run
   * scheduled refreshes.
   */
  private readStatus(vrchatUserId: string, tries = STATUS_TRIES, waitSeconds = 0): void {
    setTimeout(() => {
      void (async () => {
        const read = await this.reader.getUserStatus('manual', vrchatUserId);
        if (!read.ok) {
          const wait = read.waitSeconds ?? 60;
          if (read.reason === 'busy' && tries > 1 && wait <= MAX_SLOT_WAIT_SECONDS) this.readStatus(vrchatUserId, tries - 1, wait + 1);
          return;
        }
        await this.db.write({ requestId: randomUUID(), type: 'system', accountId: null }, (trx) =>
          trx.updateTable('vrchat.users').set(read.value).where('id', '=', vrchatUserId).execute(),
        );
      })().catch((error: unknown) => this.logger.warn(`A status read for ${vrchatUserId} failed: ${error instanceof Error ? error.message : String(error)}`));
    }, waitSeconds * 1000).unref();
  }
}
