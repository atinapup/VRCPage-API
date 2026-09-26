import { BadRequestException } from '@nestjs/common';

/*
 * Request bodies are untrusted. There is no validation library in this API,
 * so each field is read through one of these, which refuse anything that
 * isn't the expected shape before it reaches a service.
 */

export function text(body: unknown, field: string, max: number): string {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[field] : undefined;
  if (typeof value !== 'string' || value.length > max) {
    throw new BadRequestException(`${field} must be text of at most ${max} characters.`);
  }
  return value;
}

/**
 * A path on the website to send someone back to, such as /dashboard. Never a
 * full URL or a protocol-relative one, which would make this an open redirect.
 */
export function localPath(body: unknown, field: string): string {
  const value = text(body, field, 512);
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw new BadRequestException(`${field} must be a path on the website, such as /dashboard.`);
  }
  return value;
}

/** An optional true/false. Absent stays absent; anything else is refused. */
export function optionalFlag(body: unknown, field: string): boolean | undefined {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[field] : undefined;
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new BadRequestException(`${field} must be true or false.`);
  return value;
}

/** One of a fixed set of words. */
export function choice<T extends string>(body: unknown, field: string, allowed: readonly T[]): T {
  const value = text(body, field, 32);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new BadRequestException(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}
