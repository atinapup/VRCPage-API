import { ApiProperty } from '@nestjs/swagger';

/** Whether the page has a Socials page. */
export class SocialsRequest {
  enabled!: boolean;
}

/** Show or hide one of VRChat's links on the page. */
export class HiddenLinkRequest {
  /** The link as the page lists it. */
  url!: string;
  hidden!: boolean;
}

/** The page's accent colour. */
export class AccentRequest {
  /** #rrggbb, or null for vrc.page's own. */
  @ApiProperty({ type: String, nullable: true })
  accent!: string | null;
}

/** A picture or banner uploaded on vrc.page, answered with where it is served. */
export class UploadedImage {
  /** /images/<sha256 hex>.webp on the website. */
  url!: string;
}

/** How the site looks for this account. No row in the database means these defaults. */
export class Preferences {
  /** Stronger text and outlines everywhere. */
  highContrast!: boolean;
  /** OpenDyslexic for all text. */
  dyslexiaFont!: boolean;
}

/** The preferences to change; the ones left out stay as they are. */
export class PreferencesPatch {
  @ApiProperty({ required: false })
  highContrast?: boolean;
  @ApiProperty({ required: false })
  dyslexiaFont?: boolean;
}
