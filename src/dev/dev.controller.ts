import { Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Transaction } from 'kysely';
import { Audit } from '../audit/audit.js';
import { AuthService, type Viewer } from '../auth/auth.service.js';
import { recentCodes } from '../auth/delivery.js';
import { CurrentViewer, SessionGuard } from '../auth/session.guard.js';
import { choice, text } from '../common/input.js';
import { requestContext } from '../common/request-context.js';
import { DevConnectRequest, FakeReadsRequest, FakeTextRequest, FakeWorldView, SentCode } from './dev.dto.js';
import { Database } from '../database/database.js';
import { PagesService } from '../pages/pages.service.js';
import type { DB } from '../database/database.types.js';
import { FAKE_GROUPS, FAKE_IDS, FAKE_USERS, fakeWorld, type FakeGroup, type FakeUser } from '../vrchat/fake-reader.js';

/** Orin's stand-in account, which owns Night Shift and sends the invite. */
const ORIN_EMAIL = 'orin@example.com';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 26);
}

/** The first name nobody holds: base, then base-2, base-3 and so on. */
async function freeName(trx: Transaction<DB>, base: string): Promise<string> {
  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const taken = await trx.selectFrom('pages.slugs').select('slugKey').where('slugKey', '=', candidate).executeTakeFirst();
    if (!taken) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

async function connect(trx: Transaction<DB>, accountId: string, user: FakeUser): Promise<void> {
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
  const slug = await freeName(trx, slugify(user.displayName));
  await trx.insertInto('pages.slugs').values({ slugKey: slug, slug, pageId: page.id, role: 'primary' }).execute();
}

async function claim(trx: Transaction<DB>, group: FakeGroup): Promise<string> {
  await trx
    .insertInto('vrchat.groups')
    .values({
      id: group.id,
      claimedByVrchatUserId: group.ownerId,
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
      ownerVrchatUserId: group.ownerId,
      fetchedAt: new Date(),
    })
    .execute();
  const page = await trx.insertInto('pages.pages').values({ kind: 'group', vrchatGroupId: group.id }).returning('id').executeTakeFirstOrThrow();
  const slug = await freeName(trx, slugify(group.name));
  await trx.insertInto('pages.slugs').values({ slugKey: slug, slug, pageId: page.id, role: 'primary' }).execute();
  return page.id;
}

/**
 * Shortcuts that skip the vrcpage- code, so every dashboard state can be
 * reached before the real connect and claim flows exist. Only registered in
 * development (src/app.module.ts): production has no such routes at all.
 */
@ApiTags('dev')
@Controller('dev')
export class DevController {
  constructor(
    private readonly db: Database,
    private readonly auth: AuthService,
    private readonly audit: Audit,
    private readonly pages: PagesService,
  ) {}

  /** The stand-in VRChat: its users, its groups, and how reads answer. */
  @Get('vrchat/world')
  world(): FakeWorldView {
    return {
      users: fakeWorld.users().map((user) => ({ id: user.id, displayName: user.displayName, bio: user.bio })),
      groups: fakeWorld.groups().map((group) => ({
        id: group.id,
        name: group.name,
        shortCode: group.shortCode,
        discriminator: group.discriminator,
        ownerId: group.ownerId,
        description: group.description,
        privacy: group.privacy,
        memberCount: group.memberCount,
      })),
      reads: fakeWorld.failure(),
    };
  }

  /** Paste a code into a test bio, which is how a claim is proved while testing. */
  @Put('vrchat/users/:id/bio')
  @HttpCode(204)
  setBio(@Param('id') id: string, @Body() body: FakeTextRequest): void {
    if (!fakeWorld.setBio(id, text(body, 'text', 4000))) throw new NotFoundException('No test user with that id.');
  }

  /** The same for a group's description. */
  @Put('vrchat/groups/:id/description')
  @HttpCode(204)
  setDescription(@Param('id') id: string, @Body() body: FakeTextRequest): void {
    if (!fakeWorld.setDescription(id, text(body, 'text', 8000))) throw new NotFoundException('No test group with that id.');
  }

  /** Make reads fail the way VRChat does when it pushes back. */
  @Put('vrchat/reads')
  @HttpCode(204)
  setReads(@Body() body: FakeReadsRequest): void {
    fakeWorld.setFailure(choice(body, 'reads', ['none', 'rate_limited', 'unavailable'] as const));
  }

  /** The last few codes printed to the API's terminal, newest first. */
  @Get('codes')
  codes(): SentCode[] {
    return recentCodes();
  }

  /** Connect the signed-in account to a test VRChat user and give its page a free name. */
  @Post('vrchat/connect')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async connect(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Body() body: DevConnectRequest): Promise<void> {
    const user = body?.as === 'juniper' ? FAKE_USERS.juniper : FAKE_USERS.mira;
    const context = requestContext(request);
    await this.db.write({ requestId: context.requestId, type: 'account', accountId: viewer.accountId }, async (trx) => {
      const mine = await trx.selectFrom('vrchat.users').select('id').where('accountId', '=', viewer.accountId).executeTakeFirst();
      if (mine) return;
      const elsewhere = await trx.selectFrom('vrchat.users').select('id').where('id', '=', user.id).executeTakeFirst();
      if (elsewhere) throw new ConflictException(`${user.displayName} is connected to another account.`);
      await connect(trx, viewer.accountId, user);
      await this.audit.record(context, { action: 'link.succeeded', actorType: 'account', actorAccountId: viewer.accountId, metadata: { dev: true }, security: true }, trx);
    });
  }

  /** Claim the public groups the connected test user owns, up to groups.max_per_user. */
  @Post('vrchat/groups')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async claimGroups(@Req() request: Request, @CurrentViewer() viewer: Viewer): Promise<void> {
    const context = requestContext(request);
    const max = await this.db.setting<number>('groups.max_per_user');
    await this.db.write({ requestId: context.requestId, type: 'account', accountId: viewer.accountId }, async (trx) => {
      const me = await trx.selectFrom('vrchat.users').select('id').where('accountId', '=', viewer.accountId).executeTakeFirst();
      if (!me) return;
      const owned = await trx.selectFrom('vrchat.groups').select('id').where('claimedByVrchatUserId', '=', me.id).execute();
      let left = max - owned.length;
      for (const group of FAKE_GROUPS) {
        if (left <= 0) break;
        if (group.ownerId !== me.id || group.privacy !== 'default') continue;
        const taken = await trx.selectFrom('vrchat.groups').select('id').where('id', '=', group.id).executeTakeFirst();
        if (taken) continue;
        const pageId = await claim(trx, group);
        await this.audit.record(context, { action: 'group.claimed', actorType: 'account', actorAccountId: viewer.accountId, targetType: 'page', targetId: pageId, metadata: { dev: true } }, trx);
        left--;
      }
    });
  }

  /** Orin (a stand-in account, made on first use) invites the signed-in account to edit Night Shift. */
  @Post('vrchat/invite-from-orin')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async inviteFromOrin(@Req() request: Request, @CurrentViewer() viewer: Viewer): Promise<void> {
    const context = requestContext(request);
    const internal = (await this.auth.auth.$context).internalAdapter;
    const orin = (await internal.findUserByEmail(ORIN_EMAIL))?.user ?? (await internal.createUser({ email: ORIN_EMAIL, name: 'Orin', emailVerified: true }, { method: 'admin' }));

    await this.db.write({ requestId: context.requestId, type: 'account', accountId: orin.id }, async (trx) => {
      const connected = await trx.selectFrom('vrchat.users').select('id').where('accountId', '=', orin.id).executeTakeFirst();
      if (!connected) await connect(trx, orin.id, FAKE_USERS.orin);

      let page = await trx.selectFrom('pages.pages').select('id').where('vrchatGroupId', '=', FAKE_IDS.nightShift).executeTakeFirst();
      if (!page) page = { id: await claim(trx, FAKE_GROUPS.find((group) => group.id === FAKE_IDS.nightShift)!) };

      const seat = await trx.selectFrom('pages.editors').select('pageId').where('pageId', '=', page.id).where('accountId', '=', viewer.accountId).executeTakeFirst();
      const pending = await trx
        .selectFrom('pages.editorInvites')
        .select('id')
        .where('pageId', '=', page.id)
        .where('invitedAccountId', '=', viewer.accountId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (seat || pending || viewer.accountId === orin.id) return;

      const invite = await trx
        .insertInto('pages.editorInvites')
        .values({ pageId: page.id, invitedAccountId: viewer.accountId, invitedByAccountId: orin.id })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit.record(context, { action: 'group.invite_sent', actorType: 'account', actorAccountId: orin.id, targetType: 'invite', targetId: invite.id, metadata: { dev: true } }, trx);
    });
  }

  /** Accept every invite waiting for the signed-in account. */
  @Post('vrchat/accept-invites')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async acceptInvites(@Req() request: Request, @CurrentViewer() viewer: Viewer): Promise<void> {
    const context = requestContext(request);
    await this.db.write({ requestId: context.requestId, type: 'account', accountId: viewer.accountId }, async (trx) => {
      const invites = await trx
        .updateTable('pages.editorInvites')
        .set({ status: 'accepted', respondedAt: new Date() })
        .where('invitedAccountId', '=', viewer.accountId)
        .where('status', '=', 'pending')
        .returning(['id', 'pageId'])
        .execute();
      for (const invite of invites) {
        const seat = await trx.selectFrom('pages.editors').select('pageId').where('pageId', '=', invite.pageId).where('accountId', '=', viewer.accountId).executeTakeFirst();
        if (!seat) await trx.insertInto('pages.editors').values({ pageId: invite.pageId, accountId: viewer.accountId }).execute();
        await this.audit.record(context, { action: 'group.invite_accepted', actorType: 'account', actorAccountId: viewer.accountId, targetType: 'invite', targetId: invite.id, metadata: { dev: true } }, trx);
      }
    });
  }

  /** Disconnect the test VRChat user: its page, groups and their pages go with it. */
  @Delete('vrchat')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async disconnect(@Req() request: Request, @CurrentViewer() viewer: Viewer): Promise<void> {
    // The same path as the settings dialog's Disconnect, so this tests it too.
    await this.pages.disconnectVRChat(requestContext(request), viewer.accountId);
  }
}
