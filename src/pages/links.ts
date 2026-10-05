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
 */

export type LinkCheck =
  | { status: 'ok'; url: string; host: string }
  | { status: 'empty' }
  /** Not something a browser could open. */
  | { status: 'not_url' }
  /** A scheme other than https, including javascript: and data:. */
  | { status: 'not_https' }
  | { status: 'blocked'; host: string };

/** People paste bare addresses, so a missing scheme means https and nothing else. */
export function checkLink(raw: string, blocked: ReadonlySet<string>): LinkCheck {
  const text = raw.trim();
  if (!text) return { status: 'empty' };
  if (text.startsWith('//')) return { status: 'not_url' };

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
  const cases: Array<[string, string]> = [
    ['javascript:alert(1)', 'not_https'],
    ['//evil.example', 'not_url'],
    ['http://example.com', 'not_https'],
    ['example.com:443/x', 'https://example.com/x'],
    ['rtmp://ingest.example/live/secret-key', 'not_https'],
    ['rtspt://evil.example/live/x', 'not_https'],
    ['https://twitch.tv/someone', 'https://twitch.tv/someone'],
  ];
  const outcome = (check: LinkCheck) => (check.status === 'ok' ? check.url : check.status);
  const failed = cases.filter(([raw, want]) => outcome(checkLink(raw, none)) !== want);
  for (const [raw, want] of failed) console.error(`  FAILED: ${raw} gave ${outcome(checkLink(raw, none))}, wanted ${want}`);
  console.log(failed.length === 0 ? `links: ${cases.length} checks pass` : `links: ${failed.length} of ${cases.length} checks FAILED`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}
