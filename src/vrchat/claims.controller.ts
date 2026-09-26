import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Viewer } from '../auth/auth.service.js';
import { CurrentViewer, SessionGuard } from '../auth/session.guard.js';
import { text } from '../common/input.js';
import { Problem } from '../common/problem.js';
import { requestContext } from '../common/request-context.js';
import { ClaimCheck, PendingClaim, REFUSALS, StartClaimRequest } from './claims.dto.js';
import { ClaimsService, type ClaimKind, type Refusal } from './claims.service.js';
import { parseGroupRef, parseUserRef } from './ids.js';

/**
 * Claiming a VRChat account or a group: the code, and the check that reads it
 * back. Nobody ever hands over a VRChat password; control of the bio, or of
 * the group's description, is the proof.
 */
@ApiTags('vrchat')
@Controller('me/vrchat/claims')
@ApiParam({ name: 'kind', enum: ['user', 'group'], description: 'user: your own VRChat account. group: a group you own.' })
@UseGuards(SessionGuard)
export class ClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  private kindOf(raw: string): ClaimKind {
    if (raw !== 'user' && raw !== 'group') throw new NotFoundException('A claim is of a user or of a group.');
    return raw;
  }

  /** The id in whatever was pasted, or the refusal that says what was wrong with it. */
  private target(kind: ClaimKind, link: string): string {
    const ref = kind === 'user' ? parseUserRef(link) : parseGroupRef(link);
    if (ref.status === 'ok') return ref.id;
    if (ref.status === 'short_link') {
      throw new Problem(400, 'short_link', 'A vrc.group link can’t be opened here. Use the vrchat.com link from the group’s page.');
    }
    if (ref.status === 'wrong_kind') {
      throw new Problem(400, 'invalid_link', kind === 'user' ? 'That is a group. Use your own VRChat profile link.' : 'That is a profile. Use the group’s VRChat link.');
    }
    throw new Problem(400, 'invalid_link', kind === 'user' ? 'That is not a VRChat profile link.' : 'That is not a VRChat group link.');
  }

  /**
   * The same refusals whether they arrive when the code is issued or when it
   * matches, and under the same problem codes either way, so a screen needs
   * one set of words rather than two.
   */
  private problemFor(kind: ClaimKind, reason: Refusal): Problem<(typeof REFUSALS)[number]> {
    switch (reason) {
      case 'already_connected':
        return kind === 'user'
          ? new Problem(409, 'already_connected', 'This account already has a VRChat account connected.')
          : new Problem(409, 'already_connected', 'That group already has a page here.');
      case 'taken':
        return kind === 'user'
          ? new Problem(409, 'vrchat_taken', 'That VRChat account is already connected to a vrc.page account.')
          : new Problem(409, 'group_taken', 'That group is already on vrc.page under another account.');
      case 'not_connected':
        return new Problem(409, 'not_connected', 'Connect your VRChat account before adding a group.');
      case 'not_owner':
        return new Problem(403, 'not_group_owner', 'Only the group’s owner can add it. Ask them to add it and invite you as an editor.');
      case 'group_private':
        return new Problem(409, 'group_private', 'That group is private on VRChat, so its page would have nothing to show.');
      case 'limit_reached':
        return new Problem(409, 'group_limit', 'You have added as many groups as one account can.');
    }
  }

  /** The open claim, so reloading the page picks up where it left off; 404 when there is none. */
  @Get(':kind')
  async pending(@CurrentViewer() viewer: Viewer, @Param('kind') kind: string): Promise<PendingClaim> {
    const claim = await this.claims.pending(viewer.accountId, this.kindOf(kind));
    if (!claim) throw new NotFoundException('There is no claim waiting.');
    return claim;
  }

  /**
   * Start a claim: reads the account or group once, so the answer can say
   * which one it is, then issues the code to paste into it. Asking again for
   * the same one returns the code already issued.
   */
  @Post(':kind')
  @HttpCode(200)
  async start(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('kind') rawKind: string, @Body() body: StartClaimRequest): Promise<PendingClaim> {
    const kind = this.kindOf(rawKind);
    const targetId = this.target(kind, text(body, 'link', 2048));

    const result = await this.claims.start(requestContext(request), viewer.accountId, kind, targetId);
    switch (result.status) {
      case 'ok':
        return result.claim;
      case 'refused':
        throw this.problemFor(kind, result.reason);
      case 'not_found':
        throw new Problem(404, 'vrchat_not_found', kind === 'user' ? 'VRChat has no account with that id.' : 'VRChat has no group with that id.');
      default:
        throw new Problem(503, 'unavailable', 'VRChat could not be reached. Try again in a minute.');
    }
  }

  /** Give up the open claim. */
  @Delete(':kind')
  @HttpCode(204)
  async cancel(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('kind') kind: string): Promise<void> {
    await this.claims.cancel(requestContext(request), viewer.accountId, this.kindOf(kind));
  }

  /** One press of "Check now": at most one read from VRChat. */
  @Post(':kind/check')
  @HttpCode(200)
  async check(@Req() request: Request, @CurrentViewer() viewer: Viewer, @Param('kind') rawKind: string): Promise<ClaimCheck> {
    const kind = this.kindOf(rawKind);
    const result = await this.claims.check(requestContext(request), viewer.accountId, kind);
    if (result.status === 'no_claim') throw new NotFoundException('There is no claim waiting.');
    if (result.status === 'matched') return { status: 'matched', pageId: result.pageId };
    if (result.status === 'expired' || result.status === 'exhausted') return { status: result.status };
    // A refusal here is not an error: the code did match, and the screen has
    // a step to go back to.
    if (result.status === 'refused') return { status: 'refused', reason: this.problemFor(kind, result.reason).code };
    if (result.status === 'read_failed') return { status: 'read_failed', reason: result.reason, claim: result.claim };
    return { status: result.status, claim: result.claim };
  }
}
