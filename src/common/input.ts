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

/** True for a path on this site: never a full URL, and never one a browser reads as another host. */
export function isLocalPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false;
  // "/.//evil.example" and "/%2e//evil.example" collapse to "//evil.example",
  // which is another host. Resolving the path is what finds every spelling.
  try {
    return !new URL(value, 'https://vrc.page').pathname.startsWith('//');
  } catch {
    return false;
  }
}

/**
 * A path on the website to send someone back to, such as /dashboard. Never a
 * full URL or a protocol-relative one, which would make this an open redirect.
 */
export function localPath(body: unknown, field: string): string {
  const value = text(body, field, 512);
  if (!isLocalPath(value)) throw new BadRequestException(`${field} must be a path on the website, such as /dashboard.`);
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

/** The check: node --experimental-strip-types src/common/input.ts */
if (/input\.[tj]s$/.test(process.argv[1] ?? '')) {
  const cases: Array<[string, boolean]> = [
    ['/dashboard', true],
    ['/dashboard?settings=account#top', true],
    ['/a/../dashboard', true],
    ['//evil.example', false],
    ['/\\evil.example', false],
    ['/.//evil.example', false],
    ['/..//evil.example', false],
    ['/%2e//evil.example', false],
    ['/dashboard/..//evil.example', false],
    ['https://evil.example', false],
    ['dashboard', false],
  ];
  const failed = cases.filter(([path, want]) => isLocalPath(path) !== want);
  for (const [path] of failed) console.error(`  FAILED: ${path}`);
  console.log(failed.length === 0 ? `input: ${cases.length} checks pass` : `input: ${failed.length} of ${cases.length} checks FAILED`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
