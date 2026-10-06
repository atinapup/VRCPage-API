import { ApiProperty } from '@nestjs/swagger';

export const LOG_TYPES = ['auth', 'account', 'page', 'group', 'vrchat', 'admin', 'visit', 'system'] as const;
export type LogType = (typeof LOG_TYPES)[number];

export class LogActor {
  accountId!: string;
  /** The account's email, while the account exists. */
  @ApiProperty({ type: String, nullable: true })
  email!: string | null;
}

export class LogTarget {
  /** What kind of thing: account, page, slug, link, session, vrchat_user, update... */
  type!: string;
  id!: string;
  /** A name to show for it, when it is an account or a page that still exists. */
  @ApiProperty({ type: String, nullable: true })
  label!: string | null;
  /** The page's name on vrc.page, when the target is a page. */
  @ApiProperty({ type: String, nullable: true })
  slug!: string | null;
}

/** One column a change touched, before and after, as text. */
export class LogChangeField {
  /** The column, in camelCase: label, url, pictureImageId, slug... */
  name!: string;
  /** Null when there was nothing: an added row, or a column that was empty. */
  @ApiProperty({ type: String, nullable: true })
  before!: string | null;
  @ApiProperty({ type: String, nullable: true })
  after!: string | null;
  /** For a picture column, where the picture is served, while it still exists. */
  @ApiProperty({ type: String, nullable: true })
  beforeImage!: string | null;
  @ApiProperty({ type: String, nullable: true })
  afterImage!: string | null;
}

/** A row the request added, changed or removed, from audit.row_changes. */
export class LogChange {
  /** schema.table, such as pages.links. */
  table!: string;
  @ApiProperty({ enum: ['insert', 'update', 'delete'] })
  operation!: 'insert' | 'update' | 'delete';
  /** The row's key columns. */
  @ApiProperty({ type: 'object', additionalProperties: true })
  key!: Record<string, unknown>;
  @ApiProperty({ type: [LogChangeField] })
  fields!: LogChangeField[];
}

/** One thing that happened, from the audit log or a page's visits. */
export class LogEntry {
  /** Unique within the log; not an id anything else uses. */
  id!: string;
  /** When, to the microsecond, as ISO 8601 in UTC. Also the cursor for `before`. */
  at!: string;
  @ApiProperty({ enum: LOG_TYPES })
  type!: LogType;
  /** `<area>.<what happened>`, such as login.success or visit.link_clicked. */
  action!: string;
  @ApiProperty({ enum: ['info', 'warning', 'error'], description: 'info: it worked. warning: refused or rate limited. error: it failed.' })
  level!: 'info' | 'warning' | 'error';
  @ApiProperty({ enum: ['success', 'failure', 'denied', 'rate_limited'] })
  result!: 'success' | 'failure' | 'denied' | 'rate_limited';
  @ApiProperty({ enum: ['account', 'anonymous', 'staff', 'system'] })
  actorType!: 'account' | 'anonymous' | 'staff' | 'system';
  @ApiProperty({ type: LogActor, nullable: true })
  actor!: LogActor | null;
  /** Never set for a page's visits, which keep a visitor hash in metadata instead. */
  @ApiProperty({ type: String, nullable: true })
  ip!: string | null;
  @ApiProperty({ type: String, nullable: true })
  userAgent!: string | null;
  @ApiProperty({ type: String, nullable: true })
  country!: string | null;
  @ApiProperty({ type: LogTarget, nullable: true })
  target!: LogTarget | null;
  /** The API request it happened in; the same id is in that process's own log. */
  @ApiProperty({ type: String, nullable: true })
  requestId!: string | null;
  /** Detail particular to the action. Never a secret. */
  @ApiProperty({ type: 'object', additionalProperties: true })
  metadata!: Record<string, unknown>;
  /**
   * What the request changed in the database, before and after, from row
   * history. For a link's event, only that link's row; otherwise everything
   * the request changed, up to 20 rows. Empty for visits.
   */
  @ApiProperty({ type: [LogChange] })
  changes!: LogChange[];
}

export class LogPage {
  @ApiProperty({ type: [LogEntry] })
  logs!: LogEntry[];
  /** Pass as `before` for the next, older, screen; null at the end. */
  @ApiProperty({ type: String, nullable: true })
  next!: string | null;
  /** Every action logged in the range, for a filter's choices. */
  actions!: string[];
}

/** The filters, as the query string carries them. Every one is optional. */
export class LogQuery {
  /** Start of the range, ISO 8601. Defaults to 24 hours before `to`. */
  @ApiProperty({ required: false })
  from?: string;
  /** End of the range, ISO 8601, exclusive. Defaults to now. */
  @ApiProperty({ required: false })
  to?: string;
  @ApiProperty({ required: false, enum: LOG_TYPES })
  type?: LogType;
  /** One action exactly, such as login.success. */
  @ApiProperty({ required: false })
  action?: string;
  @ApiProperty({ required: false, enum: ['success', 'failure', 'denied', 'rate_limited'] })
  result?: 'success' | 'failure' | 'denied' | 'rate_limited';
  /** An account id, or part of an email address. */
  @ApiProperty({ required: false })
  user?: string;
  /** A page id or a vrc.page name. */
  @ApiProperty({ required: false })
  page?: string;
  /** An address, or a range such as 203.0.113.0/24. */
  @ApiProperty({ required: false })
  ip?: string;
  @ApiProperty({ required: false })
  requestId?: string;
  /** A metadata key. Alone, the key must be there; with `value`, it must have that value. */
  @ApiProperty({ required: false })
  field?: string;
  @ApiProperty({ required: false })
  value?: string;
  /** The `at` of the last entry already shown, from `next`. */
  @ApiProperty({ required: false })
  before?: string;
}
