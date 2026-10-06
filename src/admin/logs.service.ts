import { BadRequestException, Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import { isAddressOrRange } from '../common/input.js';
import { Database } from '../database/database.js';
import { LOG_TYPES, type LogEntry, type LogPage, type LogQuery, type LogType } from './logs.dto.js';

const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which actions belong to each type, by the area before the first dot. */
const AREAS: Record<LogType, readonly string[]> = {
  auth: ['signup', 'login', 'logout', 'email_code', 'discord', 'github'],
  account: ['account'],
  page: ['profile', 'page', 'slug', 'link_item'],
  group: ['group'],
  vrchat: ['link'],
  admin: ['admin'],
  visit: ['visit'],
  system: ['system', 'maintenance'],
};

/** The actions a page's visits appear as; they come from pages.views and pages.visit_events, not audit.events. */
const VISIT_ACTIONS = ['visit.left', 'visit.link_clicked', 'visit.page_viewed'];

function typeOf(action: string): LogType {
  const area = action.split('.')[0];
  return (Object.keys(AREAS) as LogType[]).find((type) => AREAS[type].includes(area)) ?? 'system';
}

function levelOf(result: LogEntry['result']): LogEntry['level'] {
  return result === 'success' ? 'info' : result === 'failure' ? 'error' : 'warning';
}

/** What to look for. Every field but the range is optional and narrows the rest. */
export type LogFilter = {
  from: Date;
  to: Date;
  type?: LogType;
  action?: string;
  result?: LogEntry['result'];
  /** An account id, or part of an email address: events by or about that account. */
  user?: string;
  /** A page id or a vrc.page name: events about that page, and its visits. */
  page?: string;
  /** An address, or a range such as 203.0.113.0/24. */
  ip?: string;
  requestId?: string;
  /** A metadata key, alone (it is present) or with the value it must have. */
  field?: string;
  value?: string;
  /** The `at` of the last entry already shown. */
  before?: string;
};

const RESULTS = ['success', 'failure', 'denied', 'rate_limited'] as const;
const DAY_MS = 86_400_000;

function bad(detail: string): never {
  throw new BadRequestException(detail);
}

function time(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? bad(`${field} must be a date and time, ISO 8601.`) : date;
}

/** The query string checked into a LogFilter; anything malformed is a 400, never a database error. */
export function logFilter(query: LogQuery): LogFilter {
  const to = time(query.to, 'to') ?? new Date();
  const from = time(query.from, 'from') ?? new Date(to.getTime() - DAY_MS);
  if (from >= to) bad('from must be before to.');
  const text = (value: string | undefined, max: number, field: string) =>
    value === undefined || value === '' ? undefined : value.length <= max ? value.trim() : bad(`${field} is too long.`);

  const type = query.type || undefined;
  if (type && !(LOG_TYPES as readonly string[]).includes(type)) bad(`type must be one of: ${LOG_TYPES.join(', ')}.`);
  const result = query.result || undefined;
  if (result && !(RESULTS as readonly string[]).includes(result)) bad(`result must be one of: ${RESULTS.join(', ')}.`);
  const action = text(query.action, 64, 'action');
  if (action && !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(action)) bad('action looks like login.success.');
  const ip = text(query.ip, 64, 'ip');
  if (ip && !isAddressOrRange(ip)) bad('ip must be an address, or a range such as 203.0.113.0/24.');
  const requestId = text(query.requestId, 36, 'requestId');
  if (requestId && !UUID.test(requestId)) bad('requestId must be a UUID.');
  const field = text(query.field, 40, 'field');
  if (field && !/^[A-Za-z][A-Za-z0-9_]*$/.test(field)) bad('field must be a metadata key, such as host.');
  const before = query.before ? (time(query.before, 'before'), query.before) : undefined;

  return {
    from,
    to,
    type,
    action,
    result,
    user: text(query.user, 100, 'user'),
    page: text(query.page, 64, 'page'),
    ip,
    requestId,
    field,
    // A value only means something with a field to hold it.
    value: field ? (query.value ?? undefined) : undefined,
    before,
  };
}

type Row = {
  id: string;
  at: string;
  action: string;
  result: LogEntry['result'];
  actorType: LogEntry['actorType'];
  actorAccountId: string | null;
  actorEmail: string | null;
  ip: string | null;
  userAgent: string | null;
  country: string | null;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  targetSlug: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
};

/**
 * The admin logs: audit.events, every action anyone took, merged in time
 * order with each page's visits from pages.views and pages.visit_events, so
 * one screen shows a sign-in, the page change after it and the views that
 * followed. Filters apply to every source alike; a visit has no account,
 * address or request, so filtering on those leaves visits out by itself.
 *
 * ponytail: each source is read newest-first within the range and merged
 * here; past millions of rows a range, give pages.views an occurred_at index.
 */
@Injectable()
export class LogsService {
  constructor(private readonly db: Database) {}

  async list(filter: LogFilter): Promise<LogPage> {
    const [accounts, pageId] = await Promise.all([this.accounts(filter.user), this.pageId(filter.page)]);
    const actions = this.actions(filter);
    // A user or page that matches nothing matches no events either.
    if ((filter.user && accounts.length === 0) || (filter.page && !pageId)) {
      return { logs: [], next: null, actions: await actions };
    }

    const where = this.where(filter, accounts, pageId);
    const branch = (source: RawBuilder<unknown>) =>
      sql`(SELECT * FROM (${source}) b WHERE ${where} ORDER BY b.at DESC LIMIT ${PAGE_SIZE + 1})`;

    const query = sql<Row>`
      WITH rows AS (
        SELECT * FROM (
          ${branch(sql`
            SELECT e.id::text AS id, e.occurred_at AS at, e.action, e.result::text AS result,
                   e.actor_type::text AS actor_type, e.actor_account_id, e.ip, e.user_agent,
                   e.ip_country::text AS country, e.target_type, e.target_id,
                   e.request_id::text AS request_id, e.metadata
              FROM audit.events e`)}
          UNION ALL
          ${branch(sql`
            SELECT 'view:' || coalesce(v.visit_id::text, encode(v.visitor_hash, 'hex')) || ':' || v.occurred_at::text AS id,
                   v.occurred_at AS at, 'visit.page_viewed' AS action, 'success' AS result,
                   'anonymous' AS actor_type, NULL::uuid AS actor_account_id, NULL::inet AS ip, NULL::text AS user_agent,
                   v.country::text AS country, 'page' AS target_type, v.page_id::text AS target_id,
                   NULL::text AS request_id,
                   jsonb_strip_nulls(jsonb_build_object(
                     'visit', v.visit_id, 'visitor', left(encode(v.visitor_hash, 'hex'), 12), 'referrer', v.referrer_host
                   )) AS metadata
              FROM pages.views v`)}
          UNION ALL
          ${branch(sql`
            SELECT 'event:' || x.visit_id::text || ':' || x.kind || ':' || x.occurred_at::text AS id,
                   x.occurred_at AS at,
                   CASE x.kind WHEN 'click' THEN 'visit.link_clicked' ELSE 'visit.left' END AS action,
                   'success' AS result, 'anonymous' AS actor_type, NULL::uuid AS actor_account_id,
                   NULL::inet AS ip, NULL::text AS user_agent, NULL::text AS country,
                   'page' AS target_type, x.page_id::text AS target_id, NULL::text AS request_id,
                   jsonb_strip_nulls(jsonb_build_object('visit', x.visit_id, 'url', x.link_url, 'seconds', x.seconds)) AS metadata
              FROM pages.visit_events x`)}
        ) merged
        ORDER BY at DESC, id
        LIMIT ${PAGE_SIZE + 1}
      )
      SELECT r.id,
             to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
             r.action, r.result, r.actor_type, r.actor_account_id, actor.email AS actor_email,
             host(r.ip) AS ip, r.user_agent, r.country, r.target_type, r.target_id,
             coalesce(tp.display_name, ta.email) AS target_label, tp.primary_slug AS target_slug,
             r.request_id, r.metadata
        FROM rows r
        LEFT JOIN auth.accounts actor ON actor.id = r.actor_account_id
        LEFT JOIN auth.accounts ta
          ON r.target_type = 'account'
         AND ta.id = CASE WHEN r.target_id ~* ${UUID.source} THEN r.target_id::uuid END
        LEFT JOIN pages.page_overview tp
          ON r.target_type IN ('page', 'slug', 'profile')
         AND tp.page_id = CASE WHEN r.target_id ~* ${UUID.source} THEN r.target_id::uuid END
       ORDER BY r.at DESC, r.id`;

    const [rows, choices] = await Promise.all([query.execute(this.db).then((result) => result.rows), actions]);
    const shown = rows.slice(0, PAGE_SIZE);
    return {
      logs: shown.map((row) => this.entry(row)),
      next: rows.length > PAGE_SIZE ? shown[shown.length - 1].at : null,
      actions: choices,
    };
  }

  /** Every condition, on the columns all three sources share. */
  private where(filter: LogFilter, accounts: string[], pageId: string | null): RawBuilder<unknown> {
    const conditions: RawBuilder<unknown>[] = [sql`b.at >= ${filter.from}`, sql`b.at < ${filter.to}`];
    if (filter.before) conditions.push(sql`b.at < ${filter.before}::timestamptz`);
    if (filter.type) conditions.push(sql`split_part(b.action, '.', 1) = ANY(${[...AREAS[filter.type]]}::text[])`);
    if (filter.action) conditions.push(sql`b.action = ${filter.action}`);
    if (filter.result) conditions.push(sql`b.result = ${filter.result}`);
    if (accounts.length > 0) {
      conditions.push(sql`(b.actor_account_id = ANY(${accounts}::uuid[]) OR (b.target_type = 'account' AND b.target_id = ANY(${accounts}::text[])))`);
    }
    if (pageId) conditions.push(sql`b.target_id = ${pageId}`);
    if (filter.ip) conditions.push(sql`b.ip <<= ${filter.ip}::inet`);
    if (filter.requestId) conditions.push(sql`b.request_id = ${filter.requestId}`);
    if (filter.field) {
      conditions.push(filter.value !== undefined ? sql`b.metadata ->> ${filter.field} = ${filter.value}` : sql`b.metadata ? ${filter.field}`);
    }
    return sql.join(conditions, sql` AND `);
  }

  /** The accounts a user filter means: one id, or up to 50 whose email contains the text. */
  private async accounts(user: string | undefined): Promise<string[]> {
    if (!user) return [];
    if (UUID.test(user)) return [user.toLowerCase()];
    const pattern = `%${user.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    const rows = await this.db.selectFrom('auth.accounts').select('id').where('email', 'ilike', pattern).limit(50).execute();
    return rows.map((row) => row.id);
  }

  /** The page a page filter means: its id, or the page at that name (an alias too). */
  private async pageId(page: string | undefined): Promise<string | null> {
    if (!page) return null;
    if (UUID.test(page)) return page.toLowerCase();
    const row = await this.db.selectFrom('pages.slugs').select('pageId').where('slugKey', '=', page.toLowerCase()).executeTakeFirst();
    return row?.pageId ?? null;
  }

  /** Every action logged in the range, for the action filter, visits included. */
  private async actions(filter: LogFilter): Promise<string[]> {
    const rows = await this.db
      .selectFrom('audit.events')
      .select('action')
      .distinct()
      .where('occurredAt', '>=', filter.from)
      .where('occurredAt', '<', filter.to)
      .execute();
    return [...new Set([...rows.map((row) => row.action), ...VISIT_ACTIONS])].sort();
  }

  private entry(row: Row): LogEntry {
    return {
      id: row.id,
      at: row.at,
      type: typeOf(row.action),
      action: row.action,
      level: levelOf(row.result),
      result: row.result,
      actorType: row.actorType,
      actor: row.actorAccountId ? { accountId: row.actorAccountId, email: row.actorEmail } : null,
      ip: row.ip,
      userAgent: row.userAgent,
      country: row.country,
      target: row.targetType && row.targetId ? { type: row.targetType, id: row.targetId, label: row.targetLabel, slug: row.targetSlug } : null,
      requestId: row.requestId,
      metadata: row.metadata ?? {},
    };
  }
}
