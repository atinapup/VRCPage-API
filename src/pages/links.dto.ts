import { ApiProperty } from '@nestjs/swagger';

/** One link added on vrc.page, as its page's editor sees it. */
export class OwnLink {
  id!: string;
  /** The stored https address, normalized. */
  url!: string;
  @ApiProperty({ type: String, nullable: true })
  label!: string | null;
}

/** A page's own links, in the order they are shown. */
export class PageLinks {
  links!: OwnLink[];
  /** Links one page may add, from links.custom.max_per_page. */
  @ApiProperty({ type: 'integer' })
  max!: number;
  /** Longest label, in characters. */
  @ApiProperty({ type: 'integer' })
  labelMax!: number;
  /** False when adding links is turned off for everyone. */
  enabled!: boolean;
}

/** One link on the way in. */
export class LinkInput {
  /** What was typed. A missing scheme means https; anything else is refused. */
  url!: string;
  @ApiProperty({ type: String, required: false, nullable: true })
  label?: string | null;
}

/**
 * The page's links, in full and in order. Adding, editing, reordering and
 * removing are all this one save, so a screen can send what it has and roll
 * back to exactly what it had.
 */
export class SaveLinksRequest {
  @ApiProperty({ type: [LinkInput] })
  links!: LinkInput[];
}
