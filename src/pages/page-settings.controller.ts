import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Viewer } from '../auth/auth.service.js';
import { CurrentViewer, SessionGuard } from '../auth/session.guard.js';
import { optionalFlag, text } from '../common/input.js';
import { Problem } from '../common/problem.js';
import { requestContext } from '../common/request-context.js';
import { uploadedBytes } from '../common/upload.js';
import { AccentRequest, BackgroundOpacityRequest, HiddenLinkRequest, Preferences, UploadedImage, PreferencesPatch, SocialsRequest } from './page-settings.dto.js';
import { IMAGE_LIMITS, PageSettingsService, type PageImage } from './page-settings.service.js';

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
   * A banner of the page's own, shown instead of VRChat's: the picture's own
   * bytes as the body, PNG, JPEG, WebP or GIF, up to 8 MB (any size for an
   * admin). Fitted inside 1600 pixels.
   */
  @Put('banner')
  @HttpCode(200)
  @ApiConsumes('image/png', 'image/jpeg', 'image/webp', 'image/gif')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  banner(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<UploadedImage> {
    return this.setImage(request, viewer, pageId, 'banner');
  }

  /** Take the page's own banner off, back to VRChat's. */
  @Delete('banner')
  @HttpCode(204)
  removeBanner(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<void> {
    return this.removeImage(request, viewer, pageId, 'banner');
  }

  /**
   * A picture of the page's own, shown instead of the VRChat icon: the
   * picture's own bytes as the body, PNG, JPEG, WebP or GIF, up to 8 MB (any
   * size for an admin). Cut to a square from its middle, 512 pixels across.
   */
  @Put('picture')
  @HttpCode(200)
  @ApiConsumes('image/png', 'image/jpeg', 'image/webp', 'image/gif')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  picture(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<UploadedImage> {
    return this.setImage(request, viewer, pageId, 'picture');
  }

  /** Take the page's own picture off, back to VRChat's. */
  @Delete('picture')
  @HttpCode(204)
  removePicture(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<void> {
    return this.removeImage(request, viewer, pageId, 'picture');
  }

  /**
   * A background drawn behind the whole page: the picture's own bytes as the
   * body, PNG, JPEG, WebP or GIF, up to 16 MB (any size for an admin).
   * Fitted inside 2560 pixels.
   */
  @Put('background')
  @HttpCode(200)
  @ApiConsumes('image/png', 'image/jpeg', 'image/webp', 'image/gif')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  background(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<UploadedImage> {
    return this.setImage(request, viewer, pageId, 'background');
  }

  /** Take the page's background off. */
  @Delete('background')
  @HttpCode(204)
  removeBackground(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<void> {
    return this.removeImage(request, viewer, pageId, 'background');
  }

  /** How opaque the background is, a whole number of percent from 0 to 100. 25 until changed. */
  @Put('background-opacity')
  @HttpCode(204)
  async backgroundOpacity(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string, @Body() body: BackgroundOpacityRequest): Promise<void> {
    const raw = body && typeof body === 'object' ? (body as unknown as Record<string, unknown>).opacity : undefined;
    const result = UUID.test(pageId)
      ? await this.settings.setBackgroundOpacity(requestContext(request), viewer.accountId, pageId, typeof raw === 'number' ? raw : Number.NaN)
      : 'not_found';
    if (result === 'not_found') throw noPage();
    if (result === 'bad_opacity') throw new BadRequestException('opacity must be a whole number from 0 to 100.');
  }

  private async setImage(request: Request, viewer: Viewer, pageId: string, kind: PageImage): Promise<UploadedImage> {
    const bytes = uploadedBytes(request.body);
    if (!bytes) throw new Problem(400, 'not_a_picture', 'Send the picture itself, as PNG, JPEG, WebP or GIF.');
    const result = UUID.test(pageId) ? await this.settings.setImage(requestContext(request), viewer.accountId, pageId, kind, bytes) : ({ status: 'not_found' } as const);
    switch (result.status) {
      case 'ok':
        return { url: result.url };
      case 'not_found':
        throw noPage();
      case 'too_large':
        throw new Problem(413, 'too_large', `A ${kind} can be up to ${IMAGE_LIMITS[kind] / 1024 / 1024} MB.`);
      default:
        throw new Problem(400, 'not_a_picture', 'That isn’t a picture vrc.page can use. Try a PNG, JPEG or WebP.');
    }
  }

  private async removeImage(request: Request, viewer: Viewer, pageId: string, kind: PageImage): Promise<void> {
    const result = UUID.test(pageId) ? await this.settings.removeImage(requestContext(request), viewer.accountId, pageId, kind) : 'not_found';
    if (result === 'not_found') throw noPage();
  }
}

/** How vrc.page looks for the signed-in account. */
@ApiTags('me')
@Controller('me/preferences')
@UseGuards(SessionGuard)
export class PreferencesController {
  constructor(private readonly settings: PageSettingsService) {}

  /** Higher contrast, the dyslexia font and light colours. */
  @Get()
  preferences(@CurrentViewer() viewer: Viewer): Promise<Preferences> {
    return this.settings.preferences(viewer.accountId);
  }

  /** Change some of them; the answer is all of them. */
  @Patch()
  setPreferences(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Body() body: PreferencesPatch): Promise<Preferences> {
    return this.settings.setPreferences(requestContext(request), viewer.accountId, {
      highContrast: optionalFlag(body, 'highContrast'),
      lightMode: optionalFlag(body, 'lightMode'),
      dyslexiaFont: optionalFlag(body, 'dyslexiaFont'),
    });
  }
}
