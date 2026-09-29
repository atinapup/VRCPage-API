/*
 * The six-digit code an authenticator app would show for the service account,
 * so the API can finish VRChat's sign-in without a person holding the phone.
 *
 * RFC 6238 as every authenticator app does it: HMAC-SHA1 over the count of
 * 30-second steps since 1970, cut down to six digits. It lives apart from
 * client.ts for the same reason budget.ts does: it can be checked here with no
 * database and no network.
 */
import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Whether `secret` is base32, the way VRChat shows it: any case, spaces allowed. */
export function isTotpSecret(secret: string): boolean {
  return /^[A-Z2-7=\s]+$/i.test(secret) && /[A-Z2-7]/i.test(secret);
}

function base32(secret: string): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of secret.toUpperCase().replace(/[\s=]/g, '')) {
    value = ((value << 5) | BASE32.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** The code for `secret` at `now` (milliseconds since 1970). */
export function totp(secret: string, now: number): string {
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const hmac = createHmac('sha1', base32(secret)).update(step).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** The check: node --experimental-strip-types src/vrchat/totp.ts */
if (/totp\.[tj]s$/.test(process.argv[1] ?? '')) {
  let failures = 0;
  const check = (got: unknown, want: unknown, what: string): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    failures++;
    console.error(`  FAILED: ${what}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  };

  // RFC 6238 appendix B, SHA-1, last six of the eight digits. The secret is
  // the ASCII "12345678901234567890" in base32.
  const RFC = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  check(totp(RFC, 59_000), '287082', 'RFC 6238 at 59 seconds');
  check(totp(RFC, 1_111_111_109_000), '081804', 'RFC 6238 at 1111111109, with a leading zero kept');
  check(totp(RFC, 1_111_111_111_000), '050471', 'RFC 6238 at 1111111111');
  check(totp(RFC, 1_234_567_890_000), '005924', 'RFC 6238 at 1234567890');
  check(totp(RFC, 2_000_000_000_000), '279037', 'RFC 6238 at 2000000000');
  check(totp(RFC, 20_000_000_000_000), '353130', 'RFC 6238 at 20000000000, past 2038');
  check(totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 59_000), '287082', 'lower case with spaces, as VRChat shows it');
  check(totp(RFC, 59_999), totp(RFC, 30_000), 'one code for the whole 30 seconds');

  check(isTotpSecret(RFC), true, 'a base32 secret is one');
  check(isTotpSecret('gezd gnbv===='), true, 'with spaces, padding and lower case too');
  check(isTotpSecret('GEZD1GNBV'), false, '1 is not base32');
  check(isTotpSecret('   '), false, 'nothing but spaces is not a secret');

  console.log(failures === 0 ? 'totp: 12 checks pass' : `totp: ${failures} of 12 checks FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
