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
  'session_stale',
  'not_signed_in',
  'unavailable',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

export const PROBLEM_TYPE_BASE = 'https://vrc.page/problems/';

/** An HttpException with a problem code, and how many seconds to wait when that matters. */
export class Problem extends HttpException {
  constructor(
    status: number,
    readonly code: ProblemCode,
    detail: string,
    readonly retryAfter?: number,
  ) {
    super(detail, status);
  }
}
