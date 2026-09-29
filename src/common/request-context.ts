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
 * Only the website can reach the API in production (fromWebsite in
 * request-id.ts), so nobody else gets to write this header.
 */
function clientIp(request: Request): string | null {
  const forwarded = request.get('x-forwarded-for')?.trim();
  if (forwarded && isIP(forwarded)) return forwarded;
  return request.socket.remoteAddress ?? null;
}

/**
 * The address a rate limit counts against. IPv6 hands a whole /64 to one
 * connection, so the /64 is one visitor; an IPv4 address wrapped in IPv6 is
 * the IPv4 one.
 */
export function addressKey(ip: string | null): string {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (isIP(ip) !== 6) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
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

/** The check: node --experimental-strip-types src/common/request-context.ts */
if (/request-context\.[tj]s$/.test(process.argv[1] ?? '')) {
  const cases: Array<[string | null, string]> = [
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:85a3:8d3:1319:8a2e:370:7348', '2001:db8:85a3:8d3::/64'],
    ['2001:db8:85a3:8d3::1', '2001:db8:85a3:8d3::/64'],
    ['2001:0db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    [null, 'unknown'],
  ];
  const failed = cases.filter(([ip, want]) => addressKey(ip) !== want);
  for (const [ip, want] of failed) console.error(`  FAILED: ${ip} gave ${addressKey(ip)}, wanted ${want}`);
  console.log(failed.length === 0 ? `request-context: ${cases.length} checks pass` : `request-context: ${failed.length} of ${cases.length} checks FAILED`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
