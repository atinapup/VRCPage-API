import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * The pending sign-in token: the address a code was just sent to, dated and
 * signed.
 *
 * "Send a new code" trusts this token instead of asking for another bot
 * check, which is only safe because only this API can write one, and only
 * after a check has passed. It lives exactly as long as a code does. The
 * website keeps it in an httpOnly cookie and hands it back unchanged.
 *
 *   <issued at ms>.<signature>.<email>   (the email goes last: it has dots)
 */

function sign(secret: string, issuedAt: number, email: string): string {
  return createHmac('sha256', secret).update(`pending-sign-in:${issuedAt}:${email}`).digest('base64url');
}

/** Dated when the code went out, so the token expires with the code and the resend wait can be worked out from it. */
export function issuePendingToken(secret: string, email: string, issuedAt = Date.now()): string {
  return `${issuedAt}.${sign(secret, issuedAt, email)}.${email}`;
}

/** The email inside a valid, unexpired token, or null. */
export function readPendingToken(secret: string, token: string, ttlSeconds: number): string | null {
  if (!token || token.length > 400) return null;
  const [issued, signature, ...rest] = token.split('.');
  const email = rest.join('.');
  const issuedAt = Number(issued);
  if (!email || !signature || !Number.isSafeInteger(issuedAt)) return null;

  const age = Date.now() - issuedAt;
  if (age < 0 || age > ttlSeconds * 1000) return null;

  const expected = Buffer.from(sign(secret, issuedAt, email));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return email;
}
