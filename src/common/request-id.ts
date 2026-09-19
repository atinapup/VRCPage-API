import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    /** Correlates logs, errors and the database's audit rows for one request. */
    id: string;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Gives every request an id: the caller's X-Request-Id when it is a UUID (the
 * website forwards its own), otherwise a new one. Echoed in the response.
 */
export function requestId(request: Request, response: Response, next: NextFunction): void {
  const incoming = request.get('x-request-id');
  request.id = incoming && UUID.test(incoming) ? incoming.toLowerCase() : randomUUID();
  response.setHeader('X-Request-Id', request.id);
  next();
}
