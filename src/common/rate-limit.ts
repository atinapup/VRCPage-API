import { type CanActivate, type ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service.js';
import { hit } from '../auth/cooldown.js';
import { Problem } from './problem.js';
import { addressKey, requestContext } from './request-context.js';

/*
 * How often one address may call the API. Every route gets the default; the
 * ones worth abusing (sign-in, name lookups, invites, public pages) name a
 * tighter bucket with @RateLimit. Counted in auth.rate_limits, so every API
 * instance shares the count.
 *
 * ponytail: one upsert per request. Move the hot buckets to Cloudflare
 * rate-limiting rules or Redis if it shows up in latency.
 */

type Limit = { bucket: string; max: number; windowSeconds: number };

const DEFAULT: Limit = { bucket: 'default', max: 300, windowSeconds: 60 };
const KEY = 'rateLimit';

/** A tighter limit for this route, or false for none (health checks, signed webhooks). */
export const RateLimit = (bucket: string | false, max = 0, windowSeconds = 0) =>
  SetMetadata(KEY, bucket === false ? false : ({ bucket, max, windowSeconds } satisfies Limit));

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const limit = this.reflector.getAllAndOverride<Limit | false | undefined>(KEY, [context.getHandler(), context.getClass()]) ?? DEFAULT;
    if (limit === false) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const { ok, wait } = await hit(this.auth.pool, `${limit.bucket}:${addressKey(requestContext(request).ip)}`, limit.max, limit.windowSeconds);
    if (!ok) throw new Problem(429, 'rate_limited', 'Too many requests from here. Wait a moment, then try again.', wait);
    return true;
  }
}
