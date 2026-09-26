import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Viewer } from '../auth/auth.service.js';
import { CurrentViewer, SessionGuard } from '../auth/session.guard.js';
import { choice, optionalFlag, text } from '../common/input.js';
import { Problem } from '../common/problem.js';
import { requestContext } from '../common/request-context.js';
import {
  Dashboard,
  NameAvailability,
  NameRequest,
  NotificationPreferences,
  NotificationPreferencesPatch,
  OwnGroupPage,
  OwnUserPage,
  PageName,
  PublicPage,
  Refreshed,
  VisibilityRequest,
} from './pages.dto.js';
import { PagesService } from './pages.service.js';
import { RefreshService } from './refresh.service.js';

/** Names are at most 64 characters of letters, digits, _ and - (pages.slugs). */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The same answer for every miss: nobody can tell a private page from a missing one. */
function noPage(): NotFoundException {
  return new NotFoundException('There is no page with that name.');
}

@ApiTags('pages')
@Controller('pages')
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  /** The public page at vrc.page/<slug>. Private, hidden, held and unknown names are one identical 404. */
  @Get(':slug')
  async bySlug(@Param('slug') slug: string): Promise<PublicPage> {
    if (!NAME.test(slug)) throw noPage();
    const page = await this.pages.publicPage(slug);
    if (!page) throw noPage();
    return page;
  }
}

/** The signed-in account's own things, for the dashboard. */
@ApiTags('me')
@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(
    private readonly pages: PagesService,
    private readonly refreshes: RefreshService,
  ) {}

  /** The dashboard's frame: the account's page, its groups, and what is waiting for it. */
  @Get('dashboard')
  dashboard(@CurrentViewer() viewer: Viewer): Promise<Dashboard> {
    return this.pages.dashboard(viewer.accountId);
  }

  /** The account's own page, whatever its visibility; 404 before VRChat is connected. */
  @Get('page')
  async page(@CurrentViewer() viewer: Viewer): Promise<OwnUserPage> {
    const page = await this.pages.ownUserPage(viewer.accountId);
    if (!page) throw new NotFoundException('Connect your VRChat account first.');
    return page;
  }

  /** A group page this account owns or edits; 404 for any other. */
  @Get('groups/:pageId')
  async group(@CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<OwnGroupPage> {
    const page = UUID.test(pageId) ? await this.pages.ownGroupPage(viewer.accountId, pageId) : null;
    if (!page) throw new NotFoundException('There is no group of yours with that id.');
    return page;
  }

  /** Which emails the account gets. */
  @Get('notification-preferences')
  notificationPreferences(@CurrentViewer() viewer: Viewer): Promise<NotificationPreferences> {
    return this.pages.notificationPreferences(viewer.accountId);
  }

  /**
   * Who can open one of this account's pages. Owners only: an editor could
   * otherwise unpublish a community's page. A page this account doesn't run
   * is the same 404 as one that isn't there.
   */
  @Put('pages/:pageId/visibility')
  @HttpCode(204)
  async setVisibility(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string, @Body() body: VisibilityRequest): Promise<void> {
    const visibility = choice(body, 'visibility', ['public', 'unlisted', 'private'] as const);
    const result = UUID.test(pageId)
      ? await this.pages.setVisibility(requestContext(request), viewer.accountId, pageId, visibility)
      : 'not_found';
    if (result === 'not_found') throw new NotFoundException('There is no page of yours with that id.');
    if (result === 'not_allowed') throw new Problem(403, 'not_allowed', 'Only the owner can change who can open this page.');
  }

  /** Change some of the notification preferences; the answer is all of them. */
  @Patch('notification-preferences')
  setNotificationPreferences(
    @Req() request: Request,
    @CurrentViewer() viewer: Viewer,
    @Body() body: NotificationPreferencesPatch,
  ): Promise<NotificationPreferences> {
    return this.pages.setNotificationPreferences(requestContext(request), viewer.accountId, {
      groupInvites: optionalFlag(body, 'groupInvites'),
      pageChanges: optionalFlag(body, 'pageChanges'),
      productNews: optionalFlag(body, 'productNews'),
    });
  }

  /**
   * Disconnect VRChat. The page goes, and so do the groups claimed through
   * that connection and their pages; every name is held for 90 days.
   */
  @Delete('vrchat')
  @HttpCode(204)
  async disconnectVRChat(@Req() request: Request, @CurrentViewer() viewer: Viewer): Promise<void> {
    const removed = await this.pages.disconnectVRChat(requestContext(request), viewer.accountId);
    if (!removed) throw new Problem(404, 'not_connected', 'No VRChat account is connected.');
  }

  /**
   * Whether a name can be used. Signed in, because a stranger has no business
   * mapping which names exist. `pageId` names the page asking, so its own name
   * comes back as "yours" rather than "taken".
   */
  @Get('names/:name')
  nameAvailability(@Param('name') name: string, @Query('pageId') pageId?: string): Promise<NameAvailability> {
    return this.pages.nameAvailability(name, pageId && UUID.test(pageId) ? pageId : null);
  }

  /**
   * Give one of this account's pages its name, or change it. Owners only. The
   * first name is free; after a change the name settles for slug.change_cooldown_days,
   * and the one it replaced is held so nobody can pick it up to pass as its owner.
   */
  @Put('pages/:pageId/name')
  @HttpCode(200)
  async setName(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string, @Body() body: NameRequest): Promise<PageName> {
    const name = text(body, 'name', 64);
    const result = UUID.test(pageId)
      ? await this.pages.setName(requestContext(request), viewer.accountId, pageId, name)
      : ({ status: 'not_found' } as const);

    switch (result.status) {
      case 'ok':
        return { slug: result.slug };
      case 'not_found':
        throw new NotFoundException('There is no page of yours with that id.');
      case 'not_allowed':
        throw new Problem(403, 'not_allowed', 'Only the owner can name this page.');
      case 'cooldown':
        throw new Problem(409, 'name_cooldown', `This page's name can change again on ${result.availableAt.slice(0, 10)}.`);
      default:
        throw new Problem(409, 'name_unavailable', `That name can't be used: ${result.availability.status}.`);
    }
  }

  /**
   * Read the page again from VRChat now, rather than waiting for its turn.
   * Owners only, one manual refresh per page per refresh.manual.cooldown_seconds,
   * and refresh.manual.daily_cap_per_account a day.
   */
  @Post('pages/:pageId/refresh')
  @HttpCode(200)
  async refresh(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<Refreshed> {
    const result = UUID.test(pageId)
      ? await this.refreshes.refresh(requestContext(request), viewer.accountId, pageId)
      : ({ status: 'not_found' } as const);

    switch (result.status) {
      case 'ok':
        return { refreshedAt: result.refreshedAt };
      case 'not_found':
        throw new NotFoundException('There is no page of yours with that id.');
      case 'not_allowed':
        throw new Problem(403, 'not_allowed', 'Only the owner can refresh this page.');
      case 'cooldown':
        throw new Problem(429, 'refresh_cooldown', 'This page was refreshed a moment ago.', result.wait);
      case 'daily_limit':
        throw new Problem(429, 'refresh_daily_limit', `You can refresh pages ${result.cap} times a day.`);
      case 'gone':
        throw new Problem(404, 'vrchat_gone', 'VRChat no longer has this account or group.');
      case 'unclaimed':
        throw new Problem(409, 'group_unclaimed', 'This group has another owner on VRChat now, so its page was removed.');
      default:
        throw new Problem(503, 'unavailable', 'VRChat could not be reached. Try again in a minute.');
    }
  }
}
