/*
 * Files uploaded to the API: a page's banner, and the pictures and clips in
 * "What's new" updates. They arrive as the raw request body (main.ts takes
 * these types as bytes), and are judged by their first bytes, never by the
 * name or type the sender claimed.
 */

export type UploadKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'mp4' | 'webm';

/** The content types main.ts reads as raw bytes. */
export const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];

/** The largest upload main.ts will read, in bytes: 25 MB. Each endpoint has its own, lower or equal. */
export const UPLOAD_LIMIT = 25 * 1024 * 1024;

/** What the bytes really are, or null for anything else. */
export function sniff(bytes: Buffer): UploadKind | null {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  const head = bytes.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  if (head.slice(4, 8) === 'ftyp') return 'mp4';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
  return null;
}

/** The body, when it arrived as bytes; anything else (no body, JSON) is null. */
export function uploadedBytes(body: unknown): Buffer | null {
  return Buffer.isBuffer(body) && body.length > 0 ? body : null;
}

/** The check: node --experimental-strip-types src/common/upload.ts */
if (/upload\.[tj]s$/.test(process.argv[1] ?? '')) {
  const pad = (head: number[] | string) => Buffer.concat([Buffer.from(head as never), Buffer.alloc(16)]);
  const cases: Array<[string, Buffer, UploadKind | null]> = [
    ['png', pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'png'],
    ['jpeg', pad([0xff, 0xd8, 0xff, 0xe0]), 'jpeg'],
    ['gif', pad('GIF89a'), 'gif'],
    ['webp', pad('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), 'webp'],
    ['mp4', pad('\u0000\u0000\u0000\u0018ftypmp42'), 'mp4'],
    ['webm', pad([0x1a, 0x45, 0xdf, 0xa3]), 'webm'],
    ['html', pad('<!doctype html><script>'), null],
    ['svg', pad('<svg xmlns="http://www.w3.org/2000/svg">'), null],
    ['empty', Buffer.alloc(0), null],
  ];
  const failed = cases.filter(([, bytes, want]) => sniff(bytes) !== want);
  for (const [name] of failed) console.error(`  FAILED: ${name}`);
  console.log(failed.length === 0 ? `upload: ${cases.length} checks pass` : `upload: ${failed.length} of ${cases.length} checks FAILED`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
