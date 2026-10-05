import { ApiProperty } from '@nestjs/swagger';

/** One thing a visitor did on a public page, sent by the website as it happens. */
export class VisitEvent {
  /** A random id the browser made for this visit, the same on every event of it. */
  visitId!: string;
  @ApiProperty({ enum: ['view', 'click', 'leave'], description: 'view: the page opened. click: a link on it was opened. leave: the visitor moved on.' })
  kind!: 'view' | 'click' | 'leave';
  /** For a view: the host of the page that linked here, if the browser said. */
  @ApiProperty({ type: String, required: false })
  referrer?: string;
  /** For a view: the visitor's country, as two letters, from Cloudflare. */
  @ApiProperty({ type: String, required: false })
  country?: string;
  /** For a click: the link's address, exactly as the page shows it. */
  @ApiProperty({ type: String, required: false })
  url?: string;
  /** For a leave: seconds the page was visible. */
  @ApiProperty({ type: 'integer', required: false })
  seconds?: number;
}

export class StatsTotals {
  @ApiProperty({ type: 'integer' })
  views!: number;
  /** Distinct visitors, by address, within each calendar month. */
  @ApiProperty({ type: 'integer' })
  visitors!: number;
  @ApiProperty({ type: 'integer' })
  clicks!: number;
  /** Page views after which at least one link was opened. A /<name>/<platform> redirect is a click without one. */
  @ApiProperty({ type: 'integer' })
  visitsWithClick!: number;
  /** Half of the visits that said how long they stayed were shorter than this. */
  @ApiProperty({ type: Number, nullable: true })
  medianSeconds!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  averageSeconds!: number | null;
}

export class StatsDay {
  /** A UTC day, as YYYY-MM-DD. */
  day!: string;
  @ApiProperty({ type: 'integer' })
  views!: number;
  @ApiProperty({ type: 'integer' })
  visitors!: number;
  @ApiProperty({ type: 'integer' })
  clicks!: number;
}

export class StatsDuration {
  @ApiProperty({ enum: ['<10s', '10-30s', '30s-1m', '1-3m', '3m+'] })
  bucket!: '<10s' | '10-30s' | '30s-1m' | '1-3m' | '3m+';
  @ApiProperty({ type: 'integer' })
  visits!: number;
}

/** A link on the page and how often it was opened. */
export class StatsLink {
  url!: string;
  /** The label the page gives it; null shows the address. */
  @ApiProperty({ type: String, nullable: true })
  label!: string | null;
  /** False for a link no longer on the page that was opened in the range. */
  current!: boolean;
  @ApiProperty({ type: 'integer' })
  clicks!: number;
  /** Visits that opened it at least once. */
  @ApiProperty({ type: 'integer' })
  visits!: number;
}

/** A page's stats over the last `days` UTC days, today included. */
export class PageStats {
  @ApiProperty({ enum: [7, 30, 90] })
  days!: 7 | 30 | 90;
  totals!: StatsTotals;
  @ApiProperty({ type: [StatsDay] })
  daily!: StatsDay[];
  @ApiProperty({ type: [StatsDuration] })
  durations!: StatsDuration[];
  /** Every link on the page, in its order, then removed ones that were opened. Empty for the whole site. */
  @ApiProperty({ type: [StatsLink] })
  links!: StatsLink[];
}

export class StatsCountry {
  /** Two letters, as Cloudflare names it. */
  country!: string;
  @ApiProperty({ type: 'integer' })
  views!: number;
}

export class StatsReferrer {
  /** The site that linked here; null when the browser didn't say. */
  @ApiProperty({ type: String, nullable: true })
  host!: string | null;
  @ApiProperty({ type: 'integer' })
  views!: number;
}

export class StatsHour {
  /** Hour of the day, UTC, 0 to 23. */
  @ApiProperty({ type: 'integer' })
  hour!: number;
  @ApiProperty({ type: 'integer' })
  views!: number;
}

/** One visit, newest first. */
export class StatsVisit {
  at!: string;
  pageId!: string;
  @ApiProperty({ type: String, nullable: true })
  slug!: string | null;
  @ApiProperty({ type: String, nullable: true })
  name!: string | null;
  @ApiProperty({ type: String, nullable: true })
  country!: string | null;
  @ApiProperty({ type: String, nullable: true })
  referrer!: string | null;
  /** How long the page was visible; null when the browser never said. */
  @ApiProperty({ type: 'integer', nullable: true })
  seconds!: number | null;
  /** The links opened during the visit. */
  links!: string[];
}

export class StatsSite {
  @ApiProperty({ type: 'integer' })
  accounts!: number;
  /** Accounts made in the range. */
  @ApiProperty({ type: 'integer' })
  newAccounts!: number;
  @ApiProperty({ type: 'integer' })
  pages!: number;
  @ApiProperty({ type: 'integer' })
  userPages!: number;
  @ApiProperty({ type: 'integer' })
  groupPages!: number;
  /** Public and not taken down. */
  @ApiProperty({ type: 'integer' })
  publicPages!: number;
  /** Pages viewed at least once in the range. */
  @ApiProperty({ type: 'integer' })
  activePages!: number;
}

export class StatsPage {
  pageId!: string;
  @ApiProperty({ type: String, nullable: true })
  slug!: string | null;
  @ApiProperty({ type: String, nullable: true })
  name!: string | null;
  @ApiProperty({ enum: ['user', 'group'] })
  kind!: 'user' | 'group';
  @ApiProperty({ type: 'integer' })
  views!: number;
  @ApiProperty({ type: 'integer' })
  visitors!: number;
  @ApiProperty({ type: 'integer' })
  clicks!: number;
  @ApiProperty({ type: Number, nullable: true })
  medianSeconds!: number | null;
}

export class StatsHost {
  host!: string;
  @ApiProperty({ type: 'integer' })
  clicks!: number;
}

/**
 * Everything, for staff: a page's stats plus where and when its visitors
 * came, or the same for the whole site with its biggest pages.
 */
export class AdminStats extends PageStats {
  @ApiProperty({ type: [StatsCountry] })
  countries!: StatsCountry[];
  @ApiProperty({ type: [StatsReferrer] })
  referrers!: StatsReferrer[];
  /** All 24 hours, UTC. */
  @ApiProperty({ type: [StatsHour] })
  hours!: StatsHour[];
  /** The last 50 visits. */
  @ApiProperty({ type: [StatsVisit] })
  recent!: StatsVisit[];
  /** The whole site's numbers; null for one page. */
  @ApiProperty({ type: StatsSite, nullable: true })
  site!: StatsSite | null;
  /** The most viewed pages; empty for one page. */
  @ApiProperty({ type: [StatsPage] })
  topPages!: StatsPage[];
  /** The sites links led to most; empty for one page. */
  @ApiProperty({ type: [StatsHost] })
  hosts!: StatsHost[];
}
