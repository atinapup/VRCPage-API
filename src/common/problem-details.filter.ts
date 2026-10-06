import { STATUS_CODES } from 'node:http';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Audit } from '../audit/audit.js';
import { Problem, PROBLEM_TYPE_BASE } from './problem.js';
import type { ProblemDetails } from './problem-details.dto.js';
import { requestContext } from './request-context.js';

/** What an HttpException says, without the { statusCode, error } wrapping Nest adds. */
function detailOf(exception: HttpException): string | undefined {
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join('; ');
  return typeof message === 'string' ? message : undefined;
}

/**
 * What the admin logs keep of a failed request: refusals (403), rate limits
 * (429) and server errors (5xx). The route's pattern, never its values, so no
 * page name or id lands in metadata; the request id finds the full error in
 * this process's own log. 400, 401 and 404 are ordinary traffic and stay out.
 */
function failureEvent(status: number, exception: unknown, request: Request) {
  const route = (request.route as { path?: string } | undefined)?.path ?? 'unmatched';
  const metadata = { method: request.method, route, status };
  const actor = request.viewer
    ? { actorType: 'account' as const, actorAccountId: request.viewer.accountId }
    : { actorType: 'anonymous' as const };
  if (status === 403) return { action: 'system.denied', result: 'denied' as const, ...actor, metadata };
  if (status === 429) return { action: 'system.rate_limited', result: 'rate_limited' as const, ...actor, metadata };
  if (status >= 500) {
    const error = exception instanceof Error ? exception.name : typeof exception;
    return { action: 'system.error', result: 'failure' as const, ...actor, metadata: { ...metadata, error } };
  }
  return null;
}

/**
 * Turns every exception into Problem Details. Unexpected errors are logged in
 * full and answered with a bare 500, so internals never reach a client.
 * Refusals, rate limits and errors are also written to audit.events, for the
 * admin logs, when an Audit is given.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  constructor(private readonly audit?: Audit) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const title = STATUS_CODES[status] ?? 'Error';

    if (!(exception instanceof HttpException)) {
      this.logger.error(`Request ${request.id} failed`, exception instanceof Error ? exception.stack : String(exception));
    }
    const event = this.audit ? failureEvent(status, exception, request) : null;
    // Never awaited, and record() swallows its own failure: logging an error
    // must not become a second one.
    if (event) void this.audit!.record(requestContext(request), event);

    const detail = exception instanceof HttpException ? detailOf(exception) : undefined;
    const problem: ProblemDetails = {
      type: exception instanceof Problem ? PROBLEM_TYPE_BASE + exception.code : 'about:blank',
      title,
      status,
      ...(detail && detail !== title ? { detail } : {}),
      instance: request.path,
      requestId: request.id,
      ...(exception instanceof Problem && exception.retryAfter !== undefined ? { retryAfter: exception.retryAfter } : {}),
      ...(exception instanceof Problem && exception.itemIndex !== undefined ? { at: exception.itemIndex } : {}),
    };
    if (problem.retryAfter !== undefined) response.setHeader('Retry-After', String(problem.retryAfter));
    response.status(status).type('application/problem+json').json(problem);
  }
}
