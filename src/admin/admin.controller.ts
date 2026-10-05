import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Viewer } from '../auth/auth.service.js';
import { CurrentViewer, SessionGuard } from '../auth/session.guard.js';
import { optionalFlag, text } from '../common/input.js';
import { Problem } from '../common/problem.js';
import { requestContext } from '../common/request-context.js';
import type { AccountRole } from '../pages/pages.service.js';
import { statsDays } from '../pages/stats.controller.js';
import { AdminStats } from '../pages/stats.dto.js';
import { StatsService } from '../pages/stats.service.js';
import {
  AdminAccount,
  AdminAccountList,
  AdminAccountPatch,
  AdminPage,
  AdminPageList,
  AliasPatch,
  AliasRequest,
  HideRequest,
} from './admin.dto.js';
import { AdminGuard } from './admin.guard.js';
import { AdminService } from './admin.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ROLES: readonly AccountRole[] = ['admin', 'moderator', 'partner'];

function noAccount(): NotFoundException {
  return new NotFoundException('There is no account with that id.');
}

function noPage(): NotFoundException {
  return new NotFoundException('There is no page with that id.');
}

/** A search box's text, trimmed; at most 100 characters. */
function search(query: string | undefined): string {
  return (query ?? '').trim().slice(0, 100);
}

/** A list cursor: the last id of the previous screen. */
function cursor(before: string | undefined): string | null {
  return before && UUID.test(before) ? before : null;
}

function role(value: string): AccountRole {
  if (!(ROLES as readonly string[]).includes(value)) throw new NotFoundException('There is no such role.');
  return value as AccountRole;
}

/**
 * Staff tools for any account and any page. Everything an owner can change on
 * a page, an admin changes through the owner's own endpoints under /v1/me.
 */
@ApiTags('admin')
@Controller('admin')
@UseGuards(SessionGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly stats: StatsService,
  ) {}

  /* Accounts --------------------------------------------------------------- */

  /** Accounts, newest first, 50 at a time. `q` matches the email, the VRChat name or the page name. */
  @Get('accounts')
  accounts(@Query('q') q?: string, @Query('before') before?: string): Promise<AdminAccountList> {
    return this.admin.accounts(search(q), cursor(before));
  }

  /** One account: its details, roles, sign-ins, sessions, VRChat user and pages. */
  @Get('accounts/:accountId')
  async account(@Param('accountId') accountId: string): Promise<AdminAccount> {
    const account = UUID.test(accountId) ? await this.admin.account(accountId) : null;
    if (!account) throw noAccount();
    return account;
  }

  /** Change an account's email address or name. The old address is told about a new one. */
  @Patch('accounts/:accountId')
  @HttpCode(204)
  async updateAccount(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('accountId') accountId: string, @Body() body: AdminAccountPatch): Promise<void> {
    const has = (field: string) => body && typeof body === 'object' && (body as Record<string, unknown>)[field] !== undefined;
    const patch = { email: has('email') ? text(body, 'email', 254) : undefined, name: has('name') ? text(body, 'name', 200) : undefined };
    const result = UUID.test(accountId) ? await this.admin.updateAccount(requestContext(request), viewer.accountId, accountId, patch) : 'not_found';
    if (result === 'not_found') throw noAccount();
    if (result === 'invalid_email') throw new Problem(400, 'invalid_email', 'That is not an email address.');
    if (result === 'email_taken') throw new Problem(409, 'email_taken', 'That address belongs to another account.');
  }

  /** Grant a staff role. */
  @Put('accounts/:accountId/roles/:role')
  @HttpCode(204)
  async grantRole(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('accountId') accountId: string, @Param('role') value: string): Promise<void> {
    const found = UUID.test(accountId) && (await this.admin.setRole(requestContext(request), viewer.accountId, accountId, role(value), true));
    if (!found) throw noAccount();
  }

  /** Revoke a staff role. An admin can't take away their own admin role, so nobody locks themselves out. */
  @Delete('accounts/:accountId/roles/:role')
  @HttpCode(204)
  async revokeRole(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('accountId') accountId: string, @Param('role') value: string): Promise<void> {
    const revoking = role(value);
    if (accountId === viewer.accountId && revoking === 'admin') throw new Problem(403, 'not_allowed', 'You can’t take away your own admin role.');
    const found = UUID.test(accountId) && (await this.admin.setRole(requestContext(request), viewer.accountId, accountId, revoking, false));
    if (!found) throw noAccount();
  }

  /** End every session the account has. */
  @Delete('accounts/:accountId/sessions')
  @HttpCode(204)
  async signOutEverywhere(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('accountId') accountId: string): Promise<void> {
    if (!UUID.test(accountId)) throw noAccount();
    await this.admin.signOutEverywhere(requestContext(request), viewer.accountId, accountId);
  }

  /** Disconnect its VRChat account, which takes its page and groups with it. */
  @Delete('accounts/:accountId/vrchat')
  @HttpCode(204)
  async disconnectVRChat(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('accountId') accountId: string): Promise<void> {
    const removed = UUID.test(accountId) && (await this.admin.disconnectVRChat(requestContext(request), viewer.accountId, accountId));
    if (!removed) throw new Problem(404, 'not_connected', 'That account has no VRChat account connected.');
  }

  /** Delete an account and everything it owns. Your own is deleted from Settings. */
  @Delete('accounts/:accountId')
  @HttpCode(204)
  async deleteAccount(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('accountId') accountId: string): Promise<void> {
    if (accountId === viewer.accountId) throw new Problem(403, 'not_allowed', 'Delete your own account from Settings.');
    const deleted = UUID.test(accountId) && (await this.admin.deleteAccount(requestContext(request), viewer.accountId, accountId));
    if (!deleted) throw noAccount();
  }

  /* Pages ------------------------------------------------------------------ */

  /**
   * Everything about visits over the last 7, 30 or 90 days: the whole site,
   * or one page with `pageId`. Where visitors came from and when are here
   * only, never on an owner's own stats.
   */
  @Get('stats')
  @ApiQuery({ name: 'days', required: false, enum: ['7', '30', '90'] })
  @ApiQuery({ name: 'pageId', required: false })
  async siteStats(@Query('days') days?: string, @Query('pageId') pageId?: string): Promise<AdminStats> {
    const range = statsDays(days);
    if (pageId !== undefined && !UUID.test(pageId)) throw noPage();
    const stats = await this.stats.adminStats(range, pageId ?? null);
    if (!stats) throw noPage();
    return stats;
  }

  /** Pages, newest first, 50 at a time. `q` matches a name or alias, the VRChat name or the owner's email. */
  @Get('pages')
  pages(@Query('q') q?: string, @Query('before') before?: string): Promise<AdminPageList> {
    return this.admin.pageList(search(q), cursor(before));
  }

  /** One page, whatever its visibility, with its owner, aliases and takedown. */
  @Get('pages/:pageId')
  async page(@Param('pageId') pageId: string): Promise<AdminPage> {
    const page = UUID.test(pageId) ? await this.admin.page(pageId) : null;
    if (!page) throw noPage();
    return page;
  }

  /** Take a page down. It answers like a missing page until it is restored, and its owner can't undo it. */
  @Put('pages/:pageId/hidden')
  @HttpCode(204)
  async hide(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string, @Body() body: HideRequest): Promise<void> {
    const reason = text(body, 'reason', 1000).trim();
    if (!reason) throw new BadRequestException('Say why the page is being taken down.');
    const found = UUID.test(pageId) && (await this.admin.setHidden(requestContext(request), viewer.accountId, pageId, reason));
    if (!found) throw noPage();
  }

  /** Put a page taken down back up. */
  @Delete('pages/:pageId/hidden')
  @HttpCode(204)
  async restore(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<void> {
    const found = UUID.test(pageId) && (await this.admin.setHidden(requestContext(request), viewer.accountId, pageId, null));
    if (!found) throw noPage();
  }

  /** Pick a user page as an example for the home page. Several may be picked; each visit shows one. */
  @Put('pages/:pageId/showcase')
  @HttpCode(204)
  async showcase(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<void> {
    const found = UUID.test(pageId) && (await this.admin.setShowcase(requestContext(request), viewer.accountId, pageId, true));
    if (!found) throw new NotFoundException('There is no person’s page with that id.');
  }

  /** Stop showing a page on the home page. */
  @Delete('pages/:pageId/showcase')
  @HttpCode(204)
  async unshowcase(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<void> {
    const found = UUID.test(pageId) && (await this.admin.setShowcase(requestContext(request), viewer.accountId, pageId, false));
    if (!found) throw new NotFoundException('There is no person’s page with that id.');
  }

  /** Give a page another name. By default it redirects (308) to the page's own name. */
  @Post('pages/:pageId/aliases')
  @HttpCode(204)
  async addAlias(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string, @Body() body: AliasRequest): Promise<void> {
    const name = text(body, 'name', 64);
    const redirect = optionalFlag(body, 'redirect') ?? true;
    const result = UUID.test(pageId)
      ? await this.admin.addAlias(requestContext(request), viewer.accountId, pageId, name, redirect)
      : ({ status: 'not_found' } as const);
    if (result.status === 'not_found') throw noPage();
    if (result.status === 'unavailable') throw new Problem(409, 'name_unavailable', `That name can't be used: ${result.reason}.`);
  }

  /** Whether an alias redirects to the page's own name, or shows the page at itself. */
  @Patch('pages/:pageId/aliases/:name')
  @HttpCode(204)
  async setAlias(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string, @Param('name') name: string, @Body() body: AliasPatch): Promise<void> {
    const redirect = optionalFlag(body, 'redirect');
    if (redirect === undefined) throw new BadRequestException('redirect must be true or false.');
    const found = UUID.test(pageId) && NAME.test(name) && (await this.admin.setAliasRedirect(requestContext(request), viewer.accountId, pageId, name, redirect));
    if (!found) throw new NotFoundException('That page has no such alias.');
  }

  /** Take an alias off a page. The name is held like any released name. */
  @Delete('pages/:pageId/aliases/:name')
  @HttpCode(204)
  async removeAlias(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string, @Param('name') name: string): Promise<void> {
    const found = UUID.test(pageId) && NAME.test(name) && (await this.admin.removeAlias(requestContext(request), viewer.accountId, pageId, name));
    if (!found) throw new NotFoundException('That page has no such alias.');
  }
}
