import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Viewer } from '../auth/auth.service.js';
import { CurrentViewer, SessionGuard } from '../auth/session.guard.js';
import { text } from '../common/input.js';
import { Problem } from '../common/problem.js';
import { requestContext } from '../common/request-context.js';
import { Editor, GroupEditors, Invitation, InviteRequest } from './editors.dto.js';
import { EditorsService } from './editors.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A group this account doesn't run looks exactly like one that isn't there. */
function noGroup(): NotFoundException {
  return new NotFoundException('There is no group of yours with that id.');
}

/**
 * Who helps run a group, and the invitations that put them there.
 *
 * An owner invites by vrc.page name; the person invited answers from their
 * own dashboard. Only the owner may hand out or take back a seat, and an
 * editor may always leave.
 */
@ApiTags('me')
@Controller('me')
@UseGuards(SessionGuard)
export class EditorsController {
  constructor(private readonly editors: EditorsService) {}

  /** Invitations waiting for this account's answer. */
  @Get('invitations')
  invitations(@CurrentViewer() viewer: Viewer): Promise<Invitation[]> {
    return this.editors.invitations(viewer.accountId);
  }

  /** Accept one, taking a seat on that group's page. */
  @Post('invitations/:inviteId/accept')
  @HttpCode(204)
  async accept(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('inviteId') inviteId: string): Promise<void> {
    await this.answer(request, viewer, inviteId, 'accept');
  }

  /** Decline one. The owner can ask again later. */
  @Post('invitations/:inviteId/decline')
  @HttpCode(204)
  async decline(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('inviteId') inviteId: string): Promise<void> {
    await this.answer(request, viewer, inviteId, 'decline');
  }

  private async answer(request: Request, viewer: Viewer, inviteId: string, answer: 'accept' | 'decline'): Promise<void> {
    const result = UUID.test(inviteId)
      ? await this.editors.answer(requestContext(request), viewer.accountId, inviteId, answer)
      : ({ status: 'not_found' } as const);
    if (result.status === 'not_found') throw new NotFoundException('That invitation is no longer waiting.');
    if (result.status === 'limit_reached') {
      throw new Problem(409, 'editor_limit', 'That group already has as many editors as it can. Ask its owner to make room.');
    }
  }

  /** Who runs this group: seats taken, then invitations waiting. Owners only. */
  @Get('groups/:pageId/editors')
  async list(@CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string): Promise<GroupEditors> {
    const result = UUID.test(pageId) ? await this.editors.list(viewer.accountId, pageId) : 'not_found';
    if (result === 'not_found') throw noGroup();
    if (result === 'not_allowed') throw new Problem(403, 'not_allowed', 'Only the owner can see who edits this page.');
    return result;
  }

  /** Ask the person at a vrc.page name to help run this group. Owners only. */
  @Post('groups/:pageId/editors')
  @HttpCode(200)
  async invite(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string, @Body() body: InviteRequest): Promise<Editor> {
    const name = text(body, 'name', 64);
    const result = UUID.test(pageId)
      ? await this.editors.invite(requestContext(request), viewer.accountId, pageId, name)
      : ({ status: 'not_found' } as const);

    switch (result.status) {
      case 'ok':
        return result.editor;
      case 'not_found':
        throw noGroup();
      case 'not_allowed':
        throw new Problem(403, 'not_allowed', 'Only the owner can invite editors.');
      case 'no_such_page':
        throw new Problem(404, 'no_such_page', 'Nobody on vrc.page has that name.');
      case 'yourself':
        throw new Problem(409, 'invite_self', 'You already run this group.');
      case 'already_editor':
        throw new Problem(409, 'already_editor', 'They already help run this group.');
      case 'already_invited':
        throw new Problem(409, 'already_invited', 'They have already been asked, and have not answered yet.');
      default:
        throw new Problem(409, 'editor_limit', 'This group already has as many editors as it can.');
    }
  }

  /**
   * Take a row off that list: an invitation taken back, an editor removed, or
   * an editor leaving, which anybody may do for their own seat.
   */
  @Delete('groups/:pageId/editors/:id')
  @HttpCode(204)
  async dismiss(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('pageId') pageId: string, @Param('id') id: string): Promise<void> {
    const result =
      UUID.test(pageId) && UUID.test(id)
        ? await this.editors.dismiss(requestContext(request), viewer.accountId, pageId, id)
        : ({ status: 'not_found' } as const);
    if (result.status === 'not_found') throw noGroup();
    if (result.status === 'not_allowed') throw new Problem(403, 'not_allowed', 'Only the owner can take a seat away.');
  }
}
