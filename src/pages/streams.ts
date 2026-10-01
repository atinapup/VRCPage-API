import { vrcdnPreviewUrl } from './links.js';
import type { LiveStream, PageLink } from './pages.dto.js';

/*
 * Whether a page's streams are live, for the "Live now" badge and the player
 * on the website's links view.
 *
 * VRCDN only for now. Its streams can be asked about with no account: a
 * stream's MPEG-TS address answers 200 with video while it is live, and 401
 * otherwise. Twitch and YouTube need developer keys, and come later.
 *
 * Asked when a public page is, at most every 30 seconds per stream, with a
 * short timeout, so a slow VRCDN costs a page two seconds at worst and never
 * fails it. Only the stream name taken from a stored link is ever put in the
 * address, and only VRCDN's host is contacted.
 */

const VRCDN_PREVIEW = /^https:\/\/vrcdn\.live\/preview\/([A-Za-z0-9_-]{1,64})$/;

const FRESH_MS = 30_000;
const TIMEOUT_MS = 2_000;
/** Enough for every stream on a busy day; past it the oldest answers go. */
const MAX_KNOWN = 5_000;

// ponytail: per-instance cache; a shared table if the API runs on several machines.
const known = new Map<string, { at: number; live: Promise<boolean> }>();

/** The stream's name, for a link that is a VRCDN stream's page. */
export function vrcdnName(url: string): string | null {
  return VRCDN_PREVIEW.exec(url)?.[1] ?? null;
}

async function probe(name: string): Promise<boolean> {
  try {
    const response = await fetch(`https://stream.vrcdn.live/live/${encodeURIComponent(name)}.live.ts`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    const live = response.ok && (response.headers.get('content-type') ?? '').startsWith('video/');
    // The answer is in the headers. The body is the live stream itself.
    await response.body?.cancel();
    return live;
  } catch {
    return false;
  }
}

/** Whether a VRCDN stream is live. Asks VRCDN at most every FRESH_MS; callers asking together share one answer. */
export function vrcdnLive(name: string): Promise<boolean> {
  const hit = known.get(name);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.live;
  const live = probe(name);
  known.delete(name);
  known.set(name, { at: Date.now(), live });
  if (known.size > MAX_KNOWN) known.delete(known.keys().next().value!);
  return live;
}

/** The streams among a page's links that are live right now. */
export async function liveStreams(links: PageLink[]): Promise<LiveStream[]> {
  const names = [...new Set(links.map((link) => vrcdnName(link.url)).filter((name): name is string => name !== null))];
  const checked = await Promise.all(names.map(async (name) => ({ name, live: await vrcdnLive(name) })));
  return checked.filter((stream) => stream.live).map(({ name }) => ({ platform: 'vrcdn' as const, name, url: vrcdnPreviewUrl(name) }));
}
