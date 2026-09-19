import { type CanActivate, createParamDecorator, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { Problem } from '../common/problem.js';
import { requestContext } from '../common/request-context.js';
import { AuthService, type Viewer } from './auth.service.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by SessionGuard: the account whose session cookie came with the request. */
    viewer?: Viewer;
  }
}

/**
 * Lets a request through only with a live session. The session cookie is the
 * website's (it proxies /api/auth/* here and forwards the cookie on every
 * call), and Better Auth checks it against auth.sessions.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const viewer = await this.auth.viewer(requestContext(request));
    if (!viewer) throw new Problem(401, 'not_signed_in', 'Sign in first.');
    request.viewer = viewer;
    return true;
  }
}

/** The signed-in account, in a handler behind SessionGuard. */
export const CurrentViewer = createParamDecorator((_: unknown, context: ExecutionContext): Viewer => {
  return context.switchToHttp().getRequest<Request>().viewer!;
});
