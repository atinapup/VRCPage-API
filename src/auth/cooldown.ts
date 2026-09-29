import type pg from 'pg';

/*
 * One code per address per cooldown, in auth.rate_limits (docs/database.md:
 * it "also backs the email resend cooldown"), so every API instance shares it.
 *
 * Keyed on the address, not the visitor, so a second browser can't send
 * another code seconds after the first. The slot is claimed before sending, so
 * two quick submits can't both get through, and handed back if sending fails.
 */

/** Seconds until the slot frees, or 0 when it was free and is now taken. */
export async function claimCooldown(pool: pg.Pool, key: string, seconds: number): Promise<{ wait: number; previous: number | null }> {
  const now = Date.now();
  const { rows: before } = await pool.query<{ last_request: number }>('SELECT last_request FROM auth.rate_limits WHERE key = $1', [key]);
  const previous = before[0]?.last_request ?? null;

  const { rowCount } = await pool.query(
    `INSERT INTO auth.rate_limits (key, count, last_request) VALUES ($1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET count = auth.rate_limits.count + 1, last_request = EXCLUDED.last_request
     WHERE auth.rate_limits.last_request <= $2 - $3`,
    [key, now, seconds * 1000],
  );
  if (rowCount) return { wait: 0, previous };
  return { wait: Math.max(1, Math.ceil(((previous ?? now) + seconds * 1000 - now) / 1000)), previous };
}

/** Hand a claimed slot back after the send failed. */
export async function releaseCooldown(pool: pg.Pool, key: string, previous: number | null): Promise<void> {
  if (previous === null) await pool.query('DELETE FROM auth.rate_limits WHERE key = $1', [key]);
  else await pool.query('UPDATE auth.rate_limits SET last_request = $2 WHERE key = $1', [key, previous]);
}

/** Free the slot once the code has been used, so the next sign-in isn't made to wait. */
export async function clearCooldown(pool: pg.Pool, key: string): Promise<void> {
  await pool.query('DELETE FROM auth.rate_limits WHERE key = $1', [key]);
}

/*
 * Rate limits: at most `max` hits per key in a fixed window, in the same
 * table, so every API instance counts together. For these rows last_request
 * holds when the window opened, not the latest hit. Keys start with "rl:".
 */

/** The longest window any limit uses. Rows older than this count for nothing. */
const LONGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Count one hit. `wait` is the seconds until the window reopens, when it is spent. */
export async function hit(pool: pg.Pool, key: string, max: number, windowSeconds: number): Promise<{ ok: boolean; wait: number }> {
  const now = Date.now();
  const window = windowSeconds * 1000;
  const { rows } = await pool.query<{ count: number; last_request: number }>(
    `INSERT INTO auth.rate_limits (key, count, last_request) VALUES ($1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN auth.rate_limits.last_request <= $2 - $3 THEN 1 ELSE auth.rate_limits.count + 1 END,
       last_request = CASE WHEN auth.rate_limits.last_request <= $2 - $3 THEN $2 ELSE auth.rate_limits.last_request END
     RETURNING count, last_request`,
    [`rl:${key}`, now, window],
  );
  // Counters, not logs: spent ones are swept now and then, so the table
  // doesn't grow with every address that ever called.
  if (Math.random() < 0.001) {
    void pool.query(`DELETE FROM auth.rate_limits WHERE key LIKE 'rl:%' AND last_request < $1`, [now - LONGEST_WINDOW_MS]).catch(() => undefined);
  }
  const { count, last_request } = rows[0];
  return count <= max ? { ok: true, wait: 0 } : { ok: false, wait: Math.max(1, Math.ceil((last_request + window - now) / 1000)) };
}

/** Undo one hit, for a check that turned out not to count. */
export async function unhit(pool: pg.Pool, key: string): Promise<void> {
  await pool.query('UPDATE auth.rate_limits SET count = greatest(count - 1, 0) WHERE key = $1', [`rl:${key}`]);
}
