import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Viewer } from '../auth/auth.service.js';
import { CurrentViewer, SessionGuard } from '../auth/session.guard.js';
import { choice, text } from '../common/input.js';
import { RateLimit } from '../common/rate-limit.js';
import { requestContext } from '../common/request-context.js';
import { PageStats, VisitEvent } from './stats.dto.js';
import { StatsService, type StatsDays, type VisitInput } from './stats.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How far back a stats screen looks: 7, 30 or 90 days, 30 when unsaid. */
export function statsDays(value: string | undefined): StatsDays {
  if (value === undefined || value === '') return 30;
  if (value === '7' || value === '30' || value === '90') return Number(value) as StatsDays;
  throw new BadRequestException('days must be one of: 7, 30, 90.');
}

/** An optional field: absent or null stays null, anything else must be text. */
function optionalText(body: unknown, field: string, max: number): string | null {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[field] : undefined;
  return value === undefined || value === null ? null : text(body, field, max);
}

function visit(body: unknown): VisitInput {
  const visitId = text(body, 'visitId', 36);
  if (!UUID.test(visitId)) throw new BadRequestException('visitId must be a UUID.');
  const kind = choice(body, 'kind', ['view', 'click', 'leave'] as const);
  switch (kind) {
    case 'view':
      return { kind, visitId, referrer: optionalText(body, 'referrer', 2048), country: optionalText(body, 'country', 8) };
    case 'click':
      return { kind, visitId, url: text(body, 'url', 2048) };
    case 'leave': {
      const seconds = (body as Record<string, unknown>).seconds;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) throw new BadRequestException('seconds must be a number.');
      return { kind, visitId, seconds };
    }
  }
}

/** What visitors do on public pages, sent by the website as it happens. */
@ApiTags('pages')
@Controller('pages/:pageId/events')
export class VisitsController {
  constructor(private readonly stats: StatsService) {}

  /**
   * Record one thing a visitor did: opened the page, opened one of its links,
   * or moved on. Always 204: a page nobody can open, or a link it doesn't
   * have, is dropped without saying so.
   */
  @Post()
  @HttpCode(204)
  @RateLimit('beacon', 120, 60)
  async record(@Req() request: Request, @Param('pageId') pageId: string, @Body() body: VisitEvent): Promise<void> {
    const event = visit(body);
    if (UUID.test(pageId)) await this.stats.record(requestContext(request), pageId, event);
  }
}

/** A page's stats, for its owner and editors (and admins, as on every page). */
@ApiTags('me')
@Controller('me/pages/:pageId/stats')
@UseGuards(SessionGuard)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  /** Views, unique visitors, time on page and link clicks, by UTC day, over the last 7, 30 or 90 days. */
  @Get()
  @ApiQuery({ name: 'days', required: false, enum: ['7', '30', '90'] })
  async get(@CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string, @Query('days') days?: string): Promise<PageStats> {
    const range = statsDays(days);
    const stats = UUID.test(pageId) ? await this.stats.pageStats(viewer.accountId, pageId, range) : null;
    if (!stats) throw new NotFoundException('There is no page of yours with that id.');
    return stats;
  }
}
