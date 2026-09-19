import { isIP } from 'node:net';
import type { Request } from 'express';

/** Who is asking and from where: what an audit row and Better Auth need from a request. */
export type RequestContext = {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  /** The request's headers, for Better Auth: cookies, and the address it rate-limits on. */
  headers: Headers;
};

/**
 * The visitor's address. The website forwards it as a single-value
 * X-Forwarded-For, which is the only form Better Auth trusts; anything else
 * falls back to the connection's own address.
 *
 * ponytail: any direct caller can set this header, so in production the API
 * should only be reachable through the website or a proxy that overwrites it.
 * Better Auth's advanced.ipAddress.trustedProxies is the upgrade path.
 */
function clientIp(request: Request): string | null {
  const forwarded = request.get('x-forwarded-for')?.trim();
  if (forwarded && isIP(forwarded)) return forwarded;
  return request.socket.remoteAddress ?? null;
}

export function requestContext(request: Request): RequestContext {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  const ip = clientIp(request);
  // What Better Auth rate-limits and records sessions against.
  if (ip) headers.set('x-forwarded-for', ip);
  return { requestId: request.id, ip, userAgent: request.get('user-agent')?.slice(0, 1024) ?? null, headers };
}
