import { randomUUID, timingSafeEqual } from 'node:crypto';
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
  // Better Auth reads headers, not request.id; its hooks write the id into audit rows.
  request.headers['x-request-id'] = request.id;
  response.setHeader('X-Request-Id', request.id);
  next();
}

/**
 * Lets a request in only with the secret the website sends as X-VRCPage-Secret,
 * so the website is the only caller and its X-Forwarded-For the only one ever
 * believed. Anything else gets a bare 404, as if nothing were here. The health
 * checks stay open for load balancers. Without a secret (development) every
 * caller is let in.
 */
export function fromWebsite(secret: string | null) {
  const expected = secret ? Buffer.from(secret) : null;
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!expected || request.path.startsWith('/health/')) return next();
    const given = Buffer.from(request.get('x-vrcpage-secret') ?? '');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
    response.status(404).end();
  };
}
