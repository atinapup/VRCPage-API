import { createHmac } from 'node:crypto';

/**
 * Who a page view came from, as pages.views.visitor_hash: an HMAC of the
 * visitor's address (as addressKey() gives it, so an IPv6 /64 is one
 * visitor) under a key that changes every UTC month. It counts
 * unique visitors without keeping an address, and can't be reversed without
 * the secret, which never reaches the database.
 *
 * The key is derived from the API's own signing secret, labelled so it can
 * never collide with anything Better Auth signs. A new month (or a new
 * secret) makes everyone a new visitor, which is the point.
 */
export function visitorHash(secret: string, address: string, at: Date): Buffer {
  const month = at.toISOString().slice(0, 7);
  const key = createHmac('sha256', secret).update(`vrcpage visitor ${month}`).digest();
  return createHmac('sha256', key).update(address).digest();
}

/** The check: node --experimental-strip-types src/common/visitor.ts */
if (/visitor\.[tj]s$/.test(process.argv[1] ?? '')) {
  const secret = 'x'.repeat(32);
  const october = new Date('2026-10-06T12:00:00Z');
  const lateOctober = new Date('2026-10-31T23:59:59Z');
  const november = new Date('2026-11-01T00:00:00Z');
  const same = (a: Buffer, b: Buffer) => a.equals(b);
  const cases: Array<[string, boolean]> = [
    ['32 bytes', visitorHash(secret, '203.0.113.7', october).length === 32],
    ['same address, same month', same(visitorHash(secret, '203.0.113.7', october), visitorHash(secret, '203.0.113.7', lateOctober))],
    ['same address, next month', !same(visitorHash(secret, '203.0.113.7', october), visitorHash(secret, '203.0.113.7', november))],
    ['different address', !same(visitorHash(secret, '203.0.113.7', october), visitorHash(secret, '203.0.113.8', october))],
    ['different secret', !same(visitorHash(secret, '203.0.113.7', october), visitorHash('y'.repeat(32), '203.0.113.7', october))],
  ];
  const failed = cases.filter(([, ok]) => !ok);
  for (const [name] of failed) console.error(`  FAILED: ${name}`);
  console.log(failed.length === 0 ? `visitor: ${cases.length} checks pass` : `visitor: ${failed.length} of ${cases.length} checks FAILED`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
