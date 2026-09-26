/*
 * Checking that a webhook really came from Resend.
 *
 * Resend signs with Svix, which is the Standard Webhooks scheme: HMAC-SHA256
 * over "<id>.<timestamp>.<body>", base64, compared in constant time, with the
 * timestamp checked so a captured request can't be replayed later. Twenty
 * lines of node:crypto, so no `svix` dependency.
 *
 * The body must be the bytes as they arrived. Parsing and re-serialising JSON
 * changes it (key order, spacing) and every signature then fails, which is
 * why main.ts asks Nest for the raw body.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a webhook's timestamp may be from now, in either direction. */
const TOLERANCE_SECONDS = 5 * 60;

export type SignatureHeaders = {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
};

/** Svix sends svix-*; Standard Webhooks calls the same headers webhook-*. Accept either. */
export function signatureHeaders(get: (name: string) => string | undefined): SignatureHeaders {
  return {
    id: get('svix-id') ?? get('webhook-id'),
    timestamp: get('svix-timestamp') ?? get('webhook-timestamp'),
    signature: get('svix-signature') ?? get('webhook-signature'),
  };
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * True when `body` was signed with `secret`. `now` is a parameter so the
 * timestamp rule can be tested without waiting five minutes.
 */
export function verifyWebhook(secret: string, headers: SignatureHeaders, body: Buffer, now = Date.now()): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(now / 1000 - sentAt) > TOLERANCE_SECONDS) return false;

  // whsec_<base64> is the form Resend shows; a bare base64 secret also works.
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  if (key.length === 0) return false;

  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest('base64');

  // The header holds one or more space-separated "v1,<signature>" pairs: a
  // secret being rotated signs with both the old key and the new one.
  return signature.split(' ').some((part) => {
    const [version, value] = part.split(',');
    return version === 'v1' && value !== undefined && equal(value, expected);
  });
}

/** The check: node --experimental-strip-types src/mail/signature.ts */
if (/signature\.[tj]s$/.test(process.argv[1] ?? '')) {
  let failures = 0;
  const check = (got: boolean, want: boolean, what: string): void => {
    if (got === want) return;
    failures++;
    console.error(`  FAILED: ${what}`);
  };
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
  const timestamp = '1614265330';
  const now = Number(timestamp) * 1000;
  const body = Buffer.from('{"type":"email.delivered"}');
  const sign = (key: string, at: string, payload: Buffer) =>
    `v1,${createHmac('sha256', Buffer.from(key.slice(6), 'base64')).update(`${id}.${at}.`).update(payload).digest('base64')}`;
  const good = { id, timestamp, signature: sign(secret, timestamp, body) };

  check(verifyWebhook(secret, good, body, now), true, 'a correct signature passes');
  check(verifyWebhook(secret, good, Buffer.from('{"type":"email.bounced"}'), now), false, 'a changed body fails');
  check(verifyWebhook(secret, good, body, now + 6 * 60 * 1000), false, 'a replay after the tolerance fails');
  check(verifyWebhook(`whsec_${Buffer.from('elsewhere').toString('base64')}`, good, body, now), false, 'another key fails');
  check(verifyWebhook(secret, { ...good, signature: `v2,${good.signature.slice(3)}` }, body, now), false, 'an unknown version fails');
  check(verifyWebhook(secret, { ...good, signature: `v1,wrong ${good.signature}` }, body, now), true, 'one of several signatures is enough');
  check(verifyWebhook(secret, { id, timestamp, signature: undefined }, body, now), false, 'a missing header fails');
  console.log(failures === 0 ? 'signature: 7 checks pass' : `signature: ${failures} of 7 checks FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
