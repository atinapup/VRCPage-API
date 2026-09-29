import { Controller, Get, NotFoundException, Param, Res, StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { RateLimit } from '../common/rate-limit.js';
import { Database } from '../database/database.js';

/** <sha256 hex>.webp, the only name a stored picture has. */
const FILE = /^([0-9a-f]{64})\.webp$/;

/**
 * Thirty days. A name is its content's hash, so it never changes; but a
 * deleted person's pictures must leave every cache within thirty days of
 * going from here (spec section 10), and this is how long a cache may keep one.
 */
const CACHE = 'public, max-age=2592000, immutable';

/** Pictures on pages. Public, because pages are; the website serves them at /images/<file>. */
@ApiTags('pages')
@Controller('images')
export class ImagesController {
  constructor(private readonly db: Database) {}

  /**
   * One stored icon or banner, as WebP.
   *
   * Not rate limited: it is one indexed read by hash, and most of these come
   * from the website's image optimizer, all from one address, so a limit
   * per address would throttle every visitor together.
   */
  @Get(':file')
  @RateLimit(false)
  @ApiProduces('image/webp')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async image(@Param('file') file: string, @Res({ passthrough: true }) response: Response): Promise<StreamableFile> {
    const hex = FILE.exec(file)?.[1];
    const row = hex ? await this.db.selectFrom('vrchat.images').select('bytes').where('sha256', '=', Buffer.from(hex, 'hex')).executeTakeFirst() : undefined;
    if (!row) throw new NotFoundException('There is no picture with that name.');
    response.setHeader('Cache-Control', CACHE);
    return new StreamableFile(row.bytes, { type: 'image/webp', length: row.bytes.length });
  }
}
