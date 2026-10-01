import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Viewer } from '../auth/auth.service.js';
import { CurrentViewer, SessionGuard } from '../auth/session.guard.js';
import { optionalFlag, text } from '../common/input.js';
import { Problem } from '../common/problem.js';
import { requestContext } from '../common/request-context.js';
import { uploadedBytes } from '../common/upload.js';
import { AccentRequest, HiddenLinkRequest, OwnBanner, Preferences, PreferencesPatch, SocialsRequest } from './page-settings.dto.js';
import { BANNER_LIMIT, PageSettingsService } from './page-settings.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A page this account doesn't run looks exactly like one that isn't there. */
function noPage(): NotFoundException {
  return new NotFoundException('There is no page of yours with that id.');
}

function flag(body: unknown, field: string): boolean {
  const value = optionalFlag(body, field);
  if (value === undefined) throw new BadRequestException(`${field} must be true or false.`);
  return value;
}

/** How one of this account's pages looks and what it shows. Owners and editors. */
@ApiTags('me')
@Controller('me/pages/:pageId')
@UseGuards(SessionGuard)
export class PageSettingsController {
  constructor(private readonly settings: PageSettingsService) {}

  /** Turn the page's Socials page on or off. Off, its address goes to the profile. */
  @Put('socials')
  @HttpCode(204)
  async socials(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string, @Body() body: SocialsRequest): Promise<void> {
    const enabled = flag(body, 'enabled');
    const result = UUID.test(pageId) ? await this.settings.setSocials(requestContext(request), viewer.accountId, pageId, enabled) : 'not_found';
    if (result === 'not_found') throw noPage();
  }

  /** Show or hide one of VRChat's links. The page's own links are hidden in the links save. */
  @Put('hidden-links')
  @HttpCode(204)
  async hiddenLink(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string, @Body() body: HiddenLinkRequest): Promise<void> {
    const url = text(body, 'url', 2048);
    const hidden = flag(body, 'hidden');
    const result = UUID.test(pageId) ? await this.settings.setLinkHidden(requestContext(request), viewer.accountId, pageId, url, hidden) : 'not_found';
    if (result === 'not_found') throw noPage();
    if (result === 'bad_link') throw new Problem(400, 'link_invalid', 'That is not one of the page’s links.');
  }

  /** The page's accent colour, #rrggbb, or null for vrc.page's own. */
  @Put('accent')
  @HttpCode(204)
  async accent(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string, @Body() body: AccentRequest): Promise<void> {
    const raw = body && typeof body === 'object' ? (body as unknown as Record<string, unknown>).accent : undefined;
    if (raw !== null && typeof raw !== 'string') throw new BadRequestException('accent must be a colour like #d92d3a, or null.');
    const result = UUID.test(pageId) ? await this.settings.setAccent(requestContext(request), viewer.accountId, pageId, raw) : 'not_found';
    if (result === 'not_found') throw noPage();
    if (result === 'bad_colour') throw new BadRequestException('accent must be a colour like #d92d3a, or null.');
  }

  /**
   * A banner of the page's own, shown while VRChat has none: the picture's
   * own bytes as the body, PNG, JPEG, WebP or GIF, up to 8 MB.
   */
  @Put('banner')
  @HttpCode(200)
  @ApiConsumes('image/png', 'image/jpeg', 'image/webp', 'image/gif')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  async banner(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<OwnBanner> {
    const bytes = uploadedBytes(request.body);
    if (!bytes) throw new Problem(400, 'not_a_picture', 'Send the picture itself, as PNG, JPEG, WebP or GIF.');
    const result = UUID.test(pageId) ? await this.settings.setBanner(requestContext(request), viewer.accountId, pageId, bytes) : ({ status: 'not_found' } as const);
    switch (result.status) {
      case 'ok':
        return { url: result.url };
      case 'not_found':
        throw noPage();
      case 'too_large':
        throw new Problem(413, 'too_large', `A banner can be up to ${BANNER_LIMIT / 1024 / 1024} MB.`);
      default:
        throw new Problem(400, 'not_a_picture', 'That isn’t a picture vrc.page can use. Try a PNG, JPEG or WebP.');
    }
  }

  /** Take the page's own banner off. */
  @Delete('banner')
  @HttpCode(204)
  async removeBanner(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<void> {
    const result = UUID.test(pageId) ? await this.settings.removeBanner(requestContext(request), viewer.accountId, pageId) : 'not_found';
    if (result === 'not_found') throw noPage();
  }
}

/** How vrc.page looks for the signed-in account. */
@ApiTags('me')
@Controller('me/preferences')
@UseGuards(SessionGuard)
export class PreferencesController {
  constructor(private readonly settings: PageSettingsService) {}

  /** Higher contrast and the dyslexia font. */
  @Get()
  preferences(@CurrentViewer() viewer: Viewer): Promise<Preferences> {
    return this.settings.preferences(viewer.accountId);
  }

  /** Change some of them; the answer is all of them. */
  @Patch()
  setPreferences(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Body() body: PreferencesPatch): Promise<Preferences> {
    return this.settings.setPreferences(requestContext(request), viewer.accountId, {
      highContrast: optionalFlag(body, 'highContrast'),
      dyslexiaFont: optionalFlag(body, 'dyslexiaFont'),
    });
  }
}
