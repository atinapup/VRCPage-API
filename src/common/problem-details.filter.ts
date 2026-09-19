import { STATUS_CODES } from 'node:http';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ProblemDetails } from './problem-details.dto.js';

/** What an HttpException says, without the { statusCode, error } wrapping Nest adds. */
function detailOf(exception: HttpException): string | undefined {
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join('; ');
  return typeof message === 'string' ? message : undefined;
}

/**
 * Turns every exception into Problem Details. Unexpected errors are logged in
 * full and answered with a bare 500, so internals never reach a client.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const title = STATUS_CODES[status] ?? 'Error';

    if (!(exception instanceof HttpException)) {
      this.logger.error(`Request ${request.id} failed`, exception instanceof Error ? exception.stack : String(exception));
    }

    const detail = exception instanceof HttpException ? detailOf(exception) : undefined;
    const problem: ProblemDetails = {
      type: 'about:blank',
      title,
      status,
      ...(detail && detail !== title ? { detail } : {}),
      instance: request.path,
      requestId: request.id,
    };
    response.status(status).type('application/problem+json').json(problem);
  }
}
