/*
 * The two sums that keep vrc.page inside VRChat's patience: how long to wait
 * after being pushed back, and when the daily budget starts again.
 *
 * They live apart from client.ts because they are the part worth being sure
 * about, and here they can be checked with no database and no network.
 */

/** A backoff is spread by up to this much either way, so retries don't line up. */
const JITTER = 0.2;

/**
 * How long to wait after a 429, and what to remember for the next one.
 *
 * Doubles from the first wait to the cap, and VRChat's own Retry-After wins
 * whenever it asks for longer than we chose. `wait` carries the jitter so two
 * processes that were rate-limited together don't come back together; `keep`
 * does not, so the doubling stays a clean series.
 */
export function nextBackoff(
  previousSeconds: number,
  initialSeconds: number,
  maxSeconds: number,
  retryAfterSeconds: number | null,
  spread: number = Math.random() * 2 - 1,
): { keep: number; wait: number } {
  const doubled = previousSeconds > 0 ? previousSeconds * 2 : initialSeconds;
  const keep = Math.min(Math.max(doubled, initialSeconds), maxSeconds);
  const asked = Math.max(keep, retryAfterSeconds ?? 0);
  return { keep, wait: Math.max(1, Math.round(asked * (1 + spread * JITTER))) };
}

/** Seconds from `now` until the daily budget starts again at midnight UTC. */
export function untilMidnightUtc(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** The check: node --experimental-strip-types src/vrchat/budget.ts */
if (/budget\.[tj]s$/.test(process.argv[1] ?? '')) {
  let failures = 0;
  const check = (got: unknown, want: unknown, what: string): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    failures++;
    console.error(`  FAILED: ${what}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  };

  const INITIAL = 300;
  const MAX = 21_600;
  // No jitter, so the series itself can be read.
  const steady = (previous: number, retryAfter: number | null = null) => nextBackoff(previous, INITIAL, MAX, retryAfter, 0);

  check(steady(0).keep, 300, 'the first wait after a 429 is five minutes');
  check(steady(300).keep, 600, 'the second doubles');
  check(steady(600).keep, 1200, 'and the third');
  check(steady(10_800).keep, 21_600, 'it stops at six hours');
  check(steady(21_600).keep, 21_600, 'and stays there');
  check(steady(0, 9_000).wait, 9_000, "VRChat's own Retry-After wins when it asks for longer");
  check(steady(0, 9_000).keep, 300, 'but the series we keep is still ours, so it does not jump');
  check(steady(0, 10).wait, 300, 'a shorter Retry-After does not shorten our wait');
  check(nextBackoff(300, INITIAL, MAX, null, 1).wait, 720, 'jitter can stretch a wait by a fifth');
  check(nextBackoff(300, INITIAL, MAX, null, -1).wait, 480, 'or shorten it by a fifth');
  check(nextBackoff(0, INITIAL, MAX, null, -1).wait > 0, true, 'and never to nothing');

  check(untilMidnightUtc(new Date('2026-09-28T00:00:00Z')), 86_400, 'a whole day at midnight');
  check(untilMidnightUtc(new Date('2026-09-28T23:59:59Z')), 1, 'one second before it');
  check(untilMidnightUtc(new Date('2026-12-31T23:00:00Z')), 3_600, 'an hour left on new year’s eve');
  check(untilMidnightUtc(new Date('2026-09-28T12:00:00Z')), 43_200, 'half a day at noon');

  console.log(failures === 0 ? 'budget: 15 checks pass' : `budget: ${failures} of 15 checks FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
