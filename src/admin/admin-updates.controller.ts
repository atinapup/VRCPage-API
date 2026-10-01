import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Viewer } from '../auth/auth.service.js';
import { CurrentViewer, SessionGuard } from '../auth/session.guard.js';
import { optionalFlag, text } from '../common/input.js';
import { Problem } from '../common/problem.js';
import { requestContext } from '../common/request-context.js';
import { uploadedBytes } from '../common/upload.js';
import { AdminUpdate, AdminUpdateList, UpdatePatch, UpdateRequest } from '../news/news.dto.js';
import { NewsService } from '../news/news.service.js';
import { AdminGuard } from './admin.guard.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noUpdate(): NotFoundException {
  return new NotFoundException('There is no update with that id.');
}

/** Words for an update, trimmed, refused when empty. */
function words(body: unknown, field: 'title' | 'body', max: number): string {
  const value = text(body, field, max).trim();
  if (!value) throw new BadRequestException(`An update needs a ${field}.`);
  return value;
}

/** Writing "What's new" updates. Admins only; anyone else gets a 404, as for all of /v1/admin. */
@ApiTags('admin')
@Controller('admin/updates')
@UseGuards(SessionGuard, AdminGuard)
export class AdminUpdatesController {
  constructor(private readonly news: NewsService) {}

  /** Every update, drafts included, newest first. */
  @Get()
  async list(): Promise<AdminUpdateList> {
    return { updates: await this.news.list() };
  }

  /** One update. */
  @Get(':id')
  async one(@Param('id') id: string): Promise<AdminUpdate> {
    const update = UUID.test(id) ? await this.news.one(id) : null;
    if (!update) throw noUpdate();
    return update;
  }

  /** Start one, as a draft. */
  @Post()
  async create(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Body() body: UpdateRequest): Promise<AdminUpdate> {
    const id = await this.news.create(requestContext(request), viewer.accountId, words(body, 'title', 120), words(body, 'body', 2000));
    return (await this.news.one(id))!;
  }

  /** Change its words, or publish or unpublish it. */
  @Patch(':id')
  async change(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('id') id: string, @Body() body: UpdatePatch): Promise<AdminUpdate> {
    const has = (field: string) => body && typeof body === 'object' && (body as Record<string, unknown>)[field] !== undefined;
    const patch = {
      title: has('title') ? words(body, 'title', 120) : undefined,
      body: has('body') ? words(body, 'body', 2000) : undefined,
      published: optionalFlag(body, 'published'),
    };
    const found = UUID.test(id) && (await this.news.change(requestContext(request), viewer.accountId, id, patch));
    if (!found) throw noUpdate();
    return (await this.news.one(id))!;
  }

  /** Delete it, and its picture or clip if nothing else uses that. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('id') id: string): Promise<void> {
    const found = UUID.test(id) && (await this.news.remove(requestContext(request), viewer.accountId, id));
    if (!found) throw noUpdate();
  }

  /**
   * Its picture or clip: the file's own bytes as the body. PNG, JPEG, WebP
   * and GIF become WebP (animation kept); MP4 and WebM are kept as sent. Up
   * to 25 MB.
   */
  @Put(':id/media')
  @ApiConsumes('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm')
  @ApiBody({ schema: { type: 'string', format: 'binary' } })
  async media(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('id') id: string): Promise<AdminUpdate> {
    const bytes = uploadedBytes(request.body);
    if (!bytes) throw new Problem(400, 'not_a_picture', 'Send the file itself: PNG, JPEG, WebP, GIF, MP4 or WebM.');
    const result = UUID.test(id) ? await this.news.setMedia(requestContext(request), viewer.accountId, id, bytes) : 'not_found';
    if (result === 'not_found') throw noUpdate();
    if (result === 'not_media') throw new Problem(400, 'not_a_picture', 'That isn’t a picture or clip vrc.page can use: PNG, JPEG, WebP, GIF, MP4 or WebM, up to 25 MB.');
    return (await this.news.one(id))!;
  }

  /** Take its picture or clip off. */
  @Delete(':id/media')
  async clearMedia(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('id') id: string): Promise<AdminUpdate> {
    const found = UUID.test(id) && (await this.news.clearMedia(requestContext(request), viewer.accountId, id));
    if (!found) throw noUpdate();
    return (await this.news.one(id))!;
  }
}
