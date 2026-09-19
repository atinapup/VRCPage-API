import { ApiProperty } from '@nestjs/swagger';

/**
 * An error in the RFC 9457 Problem Details format. Every non-2xx response has
 * this shape and the content type application/problem+json.
 */
export class ProblemDetails {
  /**
   * A URI naming the kind of problem: "about:blank" when the status says it
   * all, otherwise https://vrc.page/problems/<code>, with a code from
   * src/common/problem.ts.
   */
  type!: string;
  /** Short, human-readable summary of the kind of problem. */
  title!: string;
  @ApiProperty({ type: 'integer', description: 'The HTTP status code.', example: 404 })
  status!: number;
  /** What went wrong this time, in words a person can act on. */
  detail?: string;
  /** The path of the request that failed. */
  instance?: string;
  /** Same as the X-Request-Id response header and the request's audit log entries. */
  requestId!: string;
  @ApiProperty({ type: 'integer', required: false, description: 'Seconds to wait before trying again, for a cooldown.' })
  retryAfter?: number;
}
