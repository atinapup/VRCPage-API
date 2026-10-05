import { Body, Controller, Get, HttpCode, NotFoundException, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { BadRequestException } from '@nestjs/common';
import type { Viewer } from '../auth/auth.service.js';
import { CurrentViewer, SessionGuard } from '../auth/session.guard.js';
import { Problem } from '../common/problem.js';
import { requestContext } from '../common/request-context.js';
import type { SaveFailure } from './links.service.js';
import { LinksService } from './links.service.js';
import { PageLinks, SaveLinksRequest } from './links.dto.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A page this account doesn't run looks exactly like one that isn't there. */
function noPage(): NotFoundException {
  return new NotFoundException('There is no page of yours with that id.');
}

/** The links a page adds on vrc.page. Owners and editors may both change them. */
@ApiTags('me')
@Controller('me/pages/:pageId/links')
@UseGuards(SessionGuard)
export class LinksController {
  constructor(private readonly links: LinksService) {}

  /** This page's own links, in order, with the limits that apply to them. */
  @Get()
  async list(@CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<PageLinks> {
    const links = UUID.test(pageId) ? await this.links.list(viewer.accountId, pageId) : null;
    if (!links) throw noPage();
    return links;
  }

  /**
   * Replace them with this ordered list: adding, editing, reordering and
   * removing are all this one save. Nothing is written unless every link in
   * it is fit to store, and the refusal says which one was not.
   */
  @Put()
  @HttpCode(200)
  async save(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string, @Body() body: SaveLinksRequest): Promise<PageLinks> {
    const links = body?.links;
    if (!Array.isArray(links)) throw new BadRequestException('links must be a list.');

    const result = UUID.test(pageId)
      ? await this.links.save(requestContext(request), viewer.accountId, pageId, links)
      : ({ status: 'not_found' } as const);
    if (result.status === 'ok') {
      const current = await this.links.list(viewer.accountId, pageId);
      if (!current) throw noPage();
      return { ...current, links: result.links };
    }
    throw this.refusal(result);
  }

  private refusal(result: SaveFailure): Error {
    switch (result.status) {
      case 'not_found':
        return noPage();
      case 'disabled':
        return new Problem(409, 'links_disabled', 'Links added on vrc.page are turned off at the moment.');
      case 'too_many':
        return new Problem(409, 'too_many_links', `A page can have ${result.max} links of its own.`);
      default:
        break;
    }
    switch (result.reason) {
      case 'blocked':
        return new Problem(400, 'link_blocked', 'That address can’t be linked to.').at(result.at);
      case 'duplicate':
        return new Problem(400, 'link_duplicate', 'That link is already on this page.').at(result.at);
      case 'label_too_long':
        return new Problem(400, 'label_too_long', 'That label is too long.').at(result.at);
      case 'not_https':
        return new Problem(400, 'link_invalid', 'Links have to start with https.').at(result.at);
      default:
        return new Problem(400, 'link_invalid', 'That is not an address a browser could open.').at(result.at);
    }
  }
}
