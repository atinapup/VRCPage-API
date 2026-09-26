import { HttpException } from '@nestjs/common';

/**
 * Every kind of refusal a client may need to tell apart, as the last segment
 * of Problem Details' `type`: https://vrc.page/problems/<code>. A closed list,
 * so the website can switch on it instead of reading prose.
 */
export const PROBLEM_CODES = [
  'bot_check_failed',
  'cooldown',
  'invalid_email',
  'same_email',
  'email_taken',
  'signups_closed',
  'pending_expired',
  'wrong_code',
  'code_expired',
  'code_exhausted',
  'provider_not_configured',
  'not_connected',
  'not_allowed',
  'invalid_link',
  'short_link',
  'already_connected',
  'vrchat_taken',
  'vrchat_not_found',
  'group_taken',
  'not_group_owner',
  'group_private',
  'group_limit',
  'no_such_page',
  'invite_self',
  'already_editor',
  'already_invited',
  'editor_limit',
  'links_disabled',
  'too_many_links',
  'link_invalid',
  'link_blocked',
  'link_duplicate',
  'label_too_long',
  'refresh_cooldown',
  'refresh_daily_limit',
  'vrchat_gone',
  'group_unclaimed',
  'name_unavailable',
  'name_cooldown',
  'session_stale',
  'not_signed_in',
  'unavailable',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

export const PROBLEM_TYPE_BASE = 'https://vrc.page/problems/';

/** An HttpException with a problem code, and how many seconds to wait when that matters. */
export class Problem<Code extends ProblemCode = ProblemCode> extends HttpException {
  constructor(
    status: number,
    readonly code: Code,
    detail: string,
    readonly retryAfter?: number,
  ) {
    super(detail, status);
  }

  /** Which item of a submitted list this is about, when it is about one. */
  itemIndex?: number;

  /** Marks the item, and gives the problem back so it can be thrown at once. */
  at(index: number): this {
    this.itemIndex = index;
    return this;
  }
}
