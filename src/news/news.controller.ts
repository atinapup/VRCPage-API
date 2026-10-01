import { Controller, Get, HttpCode, NotFoundException, Param, Post, Req, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Viewer } from '../auth/auth.service.js';
import { CurrentViewer, SessionGuard } from '../auth/session.guard.js';
import { RateLimit } from '../common/rate-limit.js';
import { requestContext } from '../common/request-context.js';
import { UpdatesFeed } from './news.dto.js';
import { NewsService } from './news.service.js';

/** Thirty days: a name is its content's hash, so it never changes. */
const CACHE = 'public, max-age=2592000, immutable';

/** The pictures and clips in updates. Public: the website serves them at /updates/media/<file>. */
@ApiTags('updates')
@Controller('updates')
export class NewsMediaController {
  constructor(private readonly news: NewsService) {}

  /** One picture (WebP) or clip (MP4, WebM) from an update. Not rate limited, like page pictures. */
  @Get('media/:file')
  @RateLimit(false)
  @ApiProduces('image/webp', 'video/mp4', 'video/webm')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async media(@Param('file') file: string, @Res({ passthrough: true }) response: Response): Promise<StreamableFile> {
    const media = await this.news.media(file);
    if (!media) throw new NotFoundException('There is no such picture or clip.');
    response.setHeader('Cache-Control', CACHE);
    return new StreamableFile(media.bytes, { type: media.contentType, length: media.bytes.length });
  }
}

/** "What's new" for the signed-in account. */
@ApiTags('me')
@Controller('me/updates')
@UseGuards(SessionGuard)
export class MyUpdatesController {
  constructor(private readonly news: NewsService) {}

  /** The latest published updates, and which of them are new to this account. */
  @Get()
  feed(@CurrentViewer() viewer: Viewer): Promise<UpdatesFeed> {
    return this.news.feed(viewer.accountId);
  }

  /** Everything published so far has been seen. */
  @Post('seen')
  @HttpCode(204)
  async seen(@Req() request: Request, @CurrentViewer() viewer: Viewer): Promise<void> {
    await this.news.markSeen(requestContext(request), viewer.accountId);
  }
}
