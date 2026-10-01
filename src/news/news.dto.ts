import { ApiProperty } from '@nestjs/swagger';

/** One "What's new" update. */
export class Update {
  id!: string;
  title!: string;
  /** Markdown: emphasis, links, lists, headings and code. The website draws no raw HTML or images from it. */
  body!: string;
  /** /updates/media/<sha256 hex>.<webp|mp4|webm> on the website, or null. */
  @ApiProperty({ type: String, nullable: true })
  mediaUrl!: string | null;
  @ApiProperty({ enum: ['image', 'video'], nullable: true })
  mediaKind!: 'image' | 'video' | null;
  /** When it went out: ISO 8601. Null while it is a draft. */
  @ApiProperty({ type: String, nullable: true })
  publishedAt!: string | null;
}

/** The latest updates, and how far this account has read. */
export class UpdatesFeed {
  /** Published updates, newest first, at most ten. */
  updates!: Update[];
  /** Updates published after this are new to the account: ISO 8601. */
  seenAt!: string;
}

/** An update as an admin sees it. */
export class AdminUpdate extends Update {
  createdAt!: string;
  updatedAt!: string;
}

export class AdminUpdateList {
  /** Every update, drafts included, newest first. */
  updates!: AdminUpdate[];
}

/** A new update starts as a draft. */
export class UpdateRequest {
  title!: string;
  body!: string;
}

/** What to change; the fields left out stay as they are. */
export class UpdatePatch {
  @ApiProperty({ required: false })
  title?: string;
  @ApiProperty({ required: false })
  body?: string;
  /** True publishes it (keeping the first publish time); false makes it a draft again. */
  @ApiProperty({ required: false })
  published?: boolean;
}
