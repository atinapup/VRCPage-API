import { ApiProperty } from '@nestjs/swagger';

/** The VRChat account or group to claim: a link, or the id on its own. */
export class StartClaimRequest {
  /** vrchat.com/home/user/usr_… or vrchat.com/home/group/grp_…, or the id on its own. */
  link!: string;
}

/** A claim waiting for its code to appear in VRChat. */
export class PendingClaim {
  @ApiProperty({ enum: ['user', 'group'] })
  kind!: 'user' | 'group';
  /** The usr_ or grp_ id being claimed. */
  targetId!: string;
  /** Whose account, or which group, so nobody claims the wrong one. */
  displayName!: string;
  /** vrcpage- and the code to paste into the bio or description. */
  code!: string;
  /** ISO 8601. */
  expiresAt!: string;
  /** Checks left before the code is spent and a new one is needed. */
  @ApiProperty({ type: 'integer' })
  checksLeft!: number;
  /** Seconds until "Check now" works again; 0 when it does. */
  @ApiProperty({ type: 'integer' })
  checkIn!: number;
}

/**
 * Why a claim was refused, under the same problem codes a refused start
 * answers with, so a client needs one set of words rather than two.
 */
export const REFUSALS = ['already_connected', 'vrchat_taken', 'group_taken', 'not_connected', 'not_group_owner', 'group_private', 'group_limit'] as const;

/** What one press of "Check now" found. */
export class ClaimCheck {
  @ApiProperty({
    enum: ['matched', 'no_match', 'cooldown', 'read_failed', 'refused', 'expired', 'exhausted'],
    description:
      'matched: claimed. no_match: the code is not there yet. cooldown: too soon. ' +
      'read_failed: VRChat did not answer, and no check was spent. refused: the code matched but the claim is not allowed. ' +
      'expired or exhausted: start again.',
  })
  status!: 'matched' | 'no_match' | 'cooldown' | 'read_failed' | 'refused' | 'expired' | 'exhausted';
  /** Why the read failed, or why the claim was refused. */
  @ApiProperty({ required: false, enum: ['not_found', 'rate_limited', 'unavailable', ...REFUSALS] })
  reason?: 'not_found' | 'rate_limited' | 'unavailable' | (typeof REFUSALS)[number];
  /** The page that now exists, when the code matched. */
  @ApiProperty({ type: String, required: false })
  pageId?: string;
  /** Where the claim stands, while it is still open. */
  @ApiProperty({ type: PendingClaim, required: false })
  claim?: PendingClaim;
}
