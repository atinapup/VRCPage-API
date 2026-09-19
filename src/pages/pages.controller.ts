import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Viewer } from '../auth/auth.service.js';
import { CurrentViewer, SessionGuard } from '../auth/session.guard.js';
import { Dashboard, NotificationPreferences, OwnGroupPage, OwnUserPage, PublicPage } from './pages.dto.js';
import { PagesService } from './pages.service.js';

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
  constructor(private readonly pages: PagesService) {}

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
}
