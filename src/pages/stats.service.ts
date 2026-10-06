import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import { addressKey, type RequestContext } from '../common/request-context.js';
import { visitorHash } from '../common/visitor.js';
import { AppConfig } from '../config/app-config.js';
import { Database } from '../database/database.js';
import { linkIdentity } from './links.js';
import { PagesService } from './pages.service.js';
import type { AdminStats, PageStats, StatsDuration, StatsLink } from './stats.dto.js';

export type StatsDays = PageStats['days'];

/** What the website sends about one visit; the controller has checked each field's shape. */
export type VisitInput =
  | { kind: 'view'; visitId: string; referrer: string | null; country: string | null }
  | { kind: 'click'; visitId: string; url: string }
  | { kind: 'leave'; visitId: string; seconds: number };

/** Longest stay counted: a tab left open overnight says nothing about the page. */
const MAX_SECONDS = 1800;

const BUCKETS: ReadonlyArray<[StatsDuration['bucket'], number]> = [
  ['<10s', 10],
  ['10-30s', 30],
  ['30s-1m', 60],
  ['1-3m', 180],
  ['3m+', Infinity],
];

/** Cloudflare's "unknown" and "Tor" aren't countries. */
function country(value: string | null): string | null {
  return value && /^[A-Z]{2}$/.test(value) && value !== 'XX' && value !== 'T1' ? value : null;
}

/** A referring page reduced to its host, or null for anything that isn't one. */
function referrerHost(value: string | null): string | null {
  if (!value) return null;
  try {
    const host = new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase();
    return host && host.length <= 253 ? host : null;
  } catch {
    return null;
  }
}

/**
 * Page stats: recording what visitors do, and reading it back.
 *
 * Read straight from the raw logs (pages.views, pages.visit_events). Every
 * range ends today and is at most 90 days, which is how long those are kept.
 * ponytail: raw aggregation per request; roll clicks and stays into daily
 * tables like pages.view_daily if pages grow past a few hundred thousand
 * views a quarter, or to offer longer ranges.
 */
@Injectable()
export class StatsService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly pages: PagesService,
  ) {}

  /**
   * Store one thing a visitor did, or nothing. A page nobody can open, or a
   * click on a link the page doesn't have, is dropped without a word: the
   * answer is the same either way, so this can't be asked what exists, and
   * nobody can write links into someone else's stats.
   */
  async record(context: RequestContext, pageId: string, event: VisitInput): Promise<void> {
    const page = await this.pages.visibleLinks(pageId);
    if (!page?.open) return;

    let link: string | null = null;
    if (event.kind === 'click') {
      let identity: string;
      try {
        identity = linkIdentity(event.url);
      } catch {
        return;
      }
      link = page.links.find((candidate) => linkIdentity(candidate.url) === identity)?.url ?? null;
      if (!link) return;
    }

    const actor = { requestId: context.requestId, type: 'anonymous' as const, accountId: null };
    // Every row says which visitor, by the same hash, so a view, the links
    // opened after it and the leave can be followed as one person's visit.
    const visitor = visitorHash(this.config.auth.secret, addressKey(context.ip), new Date());
    await this.db.write(actor, async (trx) => {
      if (event.kind === 'view') {
        await trx
          .insertInto('pages.views')
          .values({
            pageId,
            visitId: event.visitId,
            visitorHash: visitor,
            country: country(event.country),
            referrerHost: referrerHost(event.referrer),
          })
          .execute();
      } else if (event.kind === 'click') {
        await trx.insertInto('pages.visitEvents').values({ pageId, visitId: event.visitId, visitorHash: visitor, kind: 'click', linkUrl: link }).execute();
      } else {
        const seconds = Math.min(Math.max(Math.round(event.seconds), 0), MAX_SECONDS);
        await trx.insertInto('pages.visitEvents').values({ pageId, visitId: event.visitId, visitorHash: visitor, kind: 'leave', seconds }).execute();
      }
    });
  }

  /** A page's stats, for anyone who runs it. Null when it isn't theirs, or isn't there. */
  async pageStats(accountId: string, pageId: string, days: StatsDays): Promise<PageStats | null> {
    if (!(await this.pages.role(this.db, accountId, pageId))) return null;
    return this.core(days, pageId);
  }

  /** Everything, for staff: one page when `pageId` is given, else the whole site. */
  async adminStats(days: StatsDays, pageId: string | null): Promise<AdminStats | null> {
    if (pageId && !(await this.db.selectFrom('pages.pages').select('id').where('id', '=', pageId).executeTakeFirst())) return null;
    const since = this.since(days);
    const onPage = pageId ? sql`AND page_id = ${pageId}` : sql``;
    const onViewPage = pageId ? sql`AND v.page_id = ${pageId}` : sql``;

    const [core, countries, referrers, hours, recent] = await Promise.all([
      this.core(days, pageId),
      this.rows<{ country: string; views: number }>(sql`
        SELECT country, count(*)::int AS views
          FROM pages.views
         WHERE occurred_at >= ${since} AND country IS NOT NULL ${onPage}
         GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 20`),
      this.rows<{ host: string | null; views: number }>(sql`
        SELECT referrer_host AS host, count(*)::int AS views
          FROM pages.views
         WHERE occurred_at >= ${since} ${onPage}
         GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 20`),
      this.rows<{ hour: number; views: number }>(sql`
        SELECT extract(hour FROM occurred_at AT TIME ZONE 'UTC')::int AS hour, count(*)::int AS views
          FROM pages.views
         WHERE occurred_at >= ${since} ${onPage}
         GROUP BY 1`),
      // A visit's events come within a day of its view (a stay is capped at
      // 30 minutes), which keeps each lookup to two partitions.
      this.rows<{ at: Date; pageId: string; slug: string | null; name: string | null; country: string | null; referrer: string | null; seconds: number | null; links: string[] }>(sql`
        SELECT v.occurred_at AS at, v.page_id, o.primary_slug AS slug, o.display_name AS name,
               v.country, v.referrer_host AS referrer, e.seconds, e.links
          FROM pages.views v
          LEFT JOIN pages.page_overview o ON o.page_id = v.page_id
          LEFT JOIN LATERAL (
            SELECT max(seconds) AS seconds,
                   coalesce(array_agg(DISTINCT link_url) FILTER (WHERE kind = 'click'), '{}') AS links
              FROM pages.visit_events
             WHERE visit_id = v.visit_id
               AND occurred_at >= v.occurred_at AND occurred_at < v.occurred_at + interval '1 day'
          ) e ON true
         WHERE v.occurred_at >= ${since} ${onViewPage}
         ORDER BY v.occurred_at DESC LIMIT 50`),
    ]);

    const byHour = new Map(hours.map((row) => [row.hour, row.views]));
    const stats: AdminStats = {
      ...core,
      countries,
      referrers,
      hours: Array.from({ length: 24 }, (_, hour) => ({ hour, views: byHour.get(hour) ?? 0 })),
      recent: recent.map((row) => ({ ...row, at: row.at.toISOString() })),
      site: null,
      topPages: [],
      hosts: [],
    };
    if (pageId) return stats;

    const [[site], topPages, hosts] = await Promise.all([
      this.rows<NonNullable<AdminStats['site']>>(sql`
        SELECT (SELECT count(*)::int FROM auth.accounts) AS accounts,
               (SELECT count(*)::int FROM auth.accounts WHERE created_at >= ${since}) AS new_accounts,
               count(*)::int AS pages,
               (count(*) FILTER (WHERE kind = 'user'))::int AS user_pages,
               (count(*) FILTER (WHERE kind = 'group'))::int AS group_pages,
               (count(*) FILTER (WHERE visibility = 'public' AND NOT is_hidden))::int AS public_pages,
               (SELECT count(DISTINCT page_id)::int FROM pages.views WHERE occurred_at >= ${since}) AS active_pages
          FROM pages.page_overview`),
      this.rows<AdminStats['topPages'][number]>(sql`
        WITH v AS (
          SELECT page_id, count(*) AS views, count(DISTINCT visitor_hash) AS visitors
            FROM pages.views WHERE occurred_at >= ${since} GROUP BY 1
        ), c AS (
          SELECT page_id, count(*) AS clicks
            FROM pages.visit_events WHERE kind = 'click' AND occurred_at >= ${since} GROUP BY 1
        ), s AS (
          SELECT page_id, (percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds))::int AS median_seconds
            FROM (SELECT page_id, visit_id, max(seconds) AS seconds
                    FROM pages.visit_events WHERE kind = 'leave' AND occurred_at >= ${since} GROUP BY 1, 2) stays
           GROUP BY 1
        )
        SELECT v.page_id, o.primary_slug AS slug, o.display_name AS name, o.kind,
               v.views::int, v.visitors::int, coalesce(c.clicks, 0)::int AS clicks, s.median_seconds
          FROM v
          JOIN pages.page_overview o ON o.page_id = v.page_id
          LEFT JOIN c ON c.page_id = v.page_id
          LEFT JOIN s ON s.page_id = v.page_id
         ORDER BY v.views DESC, v.page_id LIMIT 20`),
      this.rows<AdminStats['hosts'][number]>(sql`
        SELECT lower(regexp_replace(substring(link_url FROM '^https://([^/:?#]+)'), '^www[.]', '')) AS host,
               count(*)::int AS clicks
          FROM pages.visit_events
         WHERE kind = 'click' AND occurred_at >= ${since}
         GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 20`),
    ]);
    return { ...stats, site, topPages, hosts };
  }

  /** Midnight UTC at the start of the range: `days` days, today included. */
  private since(days: StatsDays): RawBuilder<Date> {
    return sql<Date>`(((now() AT TIME ZONE 'UTC')::date - ${days - 1}::int)::timestamp AT TIME ZONE 'UTC')`;
  }

  private async rows<T>(query: RawBuilder<unknown>): Promise<T[]> {
    return (await query.execute(this.db)).rows as T[];
  }

  /** Views, stays and clicks: what an owner sees, for one page or (no pageId) the whole site. */
  private async core(days: StatsDays, pageId: string | null): Promise<PageStats> {
    const since = this.since(days);
    const onPage = pageId ? sql`AND page_id = ${pageId}` : sql``;

    const [[views], [clicks], [stays], daily, links] = await Promise.all([
      this.rows<{ views: number; visitors: number }>(sql`
        SELECT count(*)::int AS views, count(DISTINCT visitor_hash)::int AS visitors
          FROM pages.views WHERE occurred_at >= ${since} ${onPage}`),
      // Visits with a click count only those that also have a view: a
      // vrc.page/<name>/<platform> redirect is a click with no page seen.
      this.rows<{ clicks: number; visitsWithClick: number }>(sql`
        SELECT count(*)::int AS clicks,
               count(DISTINCT visit_id) FILTER (
                 WHERE visit_id IN (SELECT visit_id FROM pages.views WHERE occurred_at >= ${since} ${onPage})
               )::int AS visits_with_click
          FROM pages.visit_events WHERE kind = 'click' AND occurred_at >= ${since} ${onPage}`),
      // One stay per visit: the longest the browser reported.
      this.rows<{ median: number | null; average: number | null; b0: number; b1: number; b2: number; b3: number; b4: number }>(sql`
        WITH stays AS (
          SELECT visit_id, max(seconds) AS seconds
            FROM pages.visit_events WHERE kind = 'leave' AND occurred_at >= ${since} ${onPage}
           GROUP BY 1
        )
        SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds))::int AS median,
               avg(seconds)::int AS average,
               (count(*) FILTER (WHERE seconds < ${BUCKETS[0][1]}))::int AS b0,
               (count(*) FILTER (WHERE seconds >= ${BUCKETS[0][1]} AND seconds < ${BUCKETS[1][1]}))::int AS b1,
               (count(*) FILTER (WHERE seconds >= ${BUCKETS[1][1]} AND seconds < ${BUCKETS[2][1]}))::int AS b2,
               (count(*) FILTER (WHERE seconds >= ${BUCKETS[2][1]} AND seconds < ${BUCKETS[3][1]}))::int AS b3,
               (count(*) FILTER (WHERE seconds >= ${BUCKETS[3][1]}))::int AS b4
          FROM stays`),
      this.rows<PageStats['daily'][number]>(sql`
        WITH v AS (
          SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day, count(*) AS views, count(DISTINCT visitor_hash) AS visitors
            FROM pages.views WHERE occurred_at >= ${since} ${onPage} GROUP BY 1
        ), c AS (
          SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day, count(*) AS clicks
            FROM pages.visit_events WHERE kind = 'click' AND occurred_at >= ${since} ${onPage} GROUP BY 1
        ), d AS (
          SELECT (now() AT TIME ZONE 'UTC')::date - i AS day FROM generate_series(0, ${days - 1}::int) AS i
        )
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
               coalesce(v.views, 0)::int AS views,
               coalesce(v.visitors, 0)::int AS visitors,
               coalesce(c.clicks, 0)::int AS clicks
          FROM d LEFT JOIN v ON v.day = d.day LEFT JOIN c ON c.day = d.day
         ORDER BY d.day`),
      pageId ? this.links(pageId, since) : Promise.resolve([]),
    ]);

    return {
      days,
      totals: {
        ...views,
        ...clicks,
        medianSeconds: stays.median,
        averageSeconds: stays.average,
      },
      daily,
      durations: BUCKETS.map(([bucket], i) => ({ bucket, visits: [stays.b0, stays.b1, stays.b2, stays.b3, stays.b4][i] })),
      links,
    };
  }

  /**
   * Every link the page shows, in its order, zeros included, then any link
   * since removed that was opened in the range. Matched by linkIdentity(),
   * so an edit that only tidies an address keeps its count.
   */
  private async links(pageId: string, since: RawBuilder<Date>): Promise<StatsLink[]> {
    const [page, counts] = await Promise.all([
      this.pages.visibleLinks(pageId),
      this.rows<{ url: string; clicks: number; visits: number }>(sql`
        SELECT link_url AS url, count(*)::int AS clicks, count(DISTINCT visit_id)::int AS visits
          FROM pages.visit_events
         WHERE kind = 'click' AND occurred_at >= ${since} AND page_id = ${pageId}
         GROUP BY 1`),
    ]);
    const counted = new Map<string, { url: string; clicks: number; visits: number }>();
    for (const row of counts) {
      const key = linkIdentity(row.url);
      const seen = counted.get(key);
      counted.set(key, seen ? { url: seen.url, clicks: seen.clicks + row.clicks, visits: seen.visits + row.visits } : row);
    }

    const current = (page?.links ?? []).map((link) => {
      const key = linkIdentity(link.url);
      const count = counted.get(key);
      counted.delete(key);
      return { url: link.url, label: link.label, current: true, clicks: count?.clicks ?? 0, visits: count?.visits ?? 0 };
    });
    const removed = [...counted.values()]
      .sort((a, b) => b.clicks - a.clicks)
      .map((row) => ({ url: row.url, label: null, current: false, clicks: row.clicks, visits: row.visits }));
    return [...current, ...removed];
  }
}
