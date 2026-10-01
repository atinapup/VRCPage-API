/*
 * Links people add on vrc.page, checked before anything is stored.
 *
 * This is the highest risk input in the product: an address someone types,
 * shown to everybody who opens their page. Parsing is done with the URL
 * constructor, never a regular expression, and only plain https survives,
 * which refuses javascript:, data:, vbscript:, file: and protocol-relative
 * forms by construction rather than by blocklist (spec section 15).
 *
 * The website checks the same shapes as you type. This is the check that
 * counts.
 *
 * VRCDN is the one exception to https-only. Its viewer links are rtspt:// as
 * often as https, and every form of one becomes the stream's own page,
 * https://vrcdn.live/preview/<name>, so a visitor's browser can open it. The
 * rtmp:// ingest address is the streamer's secret key, and is refused rather
 * than published.
 */

export type LinkCheck =
  | { status: 'ok'; url: string; host: string }
  | { status: 'empty' }
  /** Not something a browser could open. */
  | { status: 'not_url' }
  /** A scheme other than https, including javascript: and data:. */
  | { status: 'not_https' }
  | { status: 'blocked'; host: string }
  /** A VRCDN ingest address, which carries the secret stream key. */
  | { status: 'stream_key' };

/** A VRCDN viewer link in any of its forms; the group is the stream's name. */
const VRCDN_VIEWER = /^(?:rtspt?:\/\/|https:\/\/)?(?:www\.)?(?:stream\.vrcdn\.live\/live\/|vrcdn\.live\/preview\/)([A-Za-z0-9_-]{1,64})(?:\.live\.(?:ts|flv))?\/?$/i;
const VRCDN_INGEST = /^rtmps?:\/\/(?:[a-z0-9-]+\.)*vrcdn\.live\//i;

/** A VRCDN stream's own page, where anybody can watch it. */
export function vrcdnPreviewUrl(name: string): string {
  return `https://vrcdn.live/preview/${name}`;
}

/** People paste bare addresses, so a missing scheme means https and nothing else. */
export function checkLink(raw: string, blocked: ReadonlySet<string>): LinkCheck {
  const text = raw.trim();
  if (!text) return { status: 'empty' };
  if (text.startsWith('//')) return { status: 'not_url' };

  if (VRCDN_INGEST.test(text)) return { status: 'stream_key' };
  const stream = VRCDN_VIEWER.exec(text);
  if (stream) {
    if (isBlocked('vrcdn.live', blocked)) return { status: 'blocked', host: 'vrcdn.live' };
    return { status: 'ok', url: vrcdnPreviewUrl(stream[1]), host: 'vrcdn.live' };
  }

  // "example.com:443/x" starts like a scheme but is a host and port. A real
  // scheme is followed by //, or is a single-colon kind with no dot in it,
  // which is where javascript:, data: and mailto: live.
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  const scheme = match && (text.slice(match[0].length).startsWith('//') || !match[1].includes('.')) ? match[1].toLowerCase() : null;
  if (scheme !== null && scheme !== 'https') return { status: 'not_https' };

  let url: URL;
  try {
    url = new URL(scheme ? text : `https://${text}`);
  } catch {
    return { status: 'not_url' };
  }
  if (url.protocol !== 'https:') return { status: 'not_https' };

  // Credentials and a default port are stripped before the address is stored
  // or shown, so the host somebody reads is the host their browser contacts.
  url.username = '';
  url.password = '';
  if (url.port === '443') url.port = '';

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return { status: 'not_url' };
  if (isBlocked(host, blocked)) return { status: 'blocked', host };
  if (url.href.length > 2048) return { status: 'not_url' };

  return { status: 'ok', url: url.href, host };
}

/** A blocked host blocks its subdomains too: "grabify.link" also refuses "x.grabify.link". */
function isBlocked(host: string, blocked: ReadonlySet<string>): boolean {
  for (let at = host; at.includes('.'); at = at.slice(at.indexOf('.') + 1)) {
    if (blocked.has(at)) return true;
  }
  return false;
}

/**
 * What makes two links the same link: the host with or without www, the path
 * with or without a trailing slash, and the query. Used to refuse the same
 * link twice, and to show it once when VRChat has it too.
 */
export function linkIdentity(url: string): string {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  return `${host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
}

/** The check: node --experimental-strip-types src/pages/links.ts */
if (/links\.[tj]s$/.test(process.argv[1] ?? '')) {
  const none: ReadonlySet<string> = new Set();
  const preview = 'https://vrcdn.live/preview/Club_Night-2';
  const cases: Array<[string, string]> = [
    ['rtspt://stream.vrcdn.live/live/Club_Night-2', preview],
    ['rtsp://stream.vrcdn.live/live/Club_Night-2', preview],
    ['https://stream.vrcdn.live/live/Club_Night-2.live.ts', preview],
    ['https://stream.vrcdn.live/live/Club_Night-2.live.flv', preview],
    ['stream.vrcdn.live/live/Club_Night-2', preview],
    ['https://vrcdn.live/preview/Club_Night-2', preview],
    ['vrcdn.live/preview/Club_Night-2/', preview],
    ['rtmp://ingest.vrcdn.live/live/secret-key', 'stream_key'],
    ['rtmps://eu.ingest.vrcdn.live/live/secret-key', 'stream_key'],
    ['rtspt://stream.vrcdn.live/live/../etc', 'not_https'],
    ['rtspt://evil.example/live/x', 'not_https'],
    ['https://vrcdn.live/preview/a/b', 'https://vrcdn.live/preview/a/b'],
    ['https://twitch.tv/someone', 'https://twitch.tv/someone'],
  ];
  const outcome = (check: LinkCheck) => (check.status === 'ok' ? check.url : check.status);
  const failed = cases.filter(([raw, want]) => outcome(checkLink(raw, none)) !== want);
  for (const [raw, want] of failed) console.error(`  FAILED: ${raw} gave ${outcome(checkLink(raw, none))}, wanted ${want}`);
  console.log(failed.length === 0 ? `links: ${cases.length} checks pass` : `links: ${failed.length} of ${cases.length} checks FAILED`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
