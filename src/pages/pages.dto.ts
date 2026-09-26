import { ApiProperty } from '@nestjs/swagger';

/** A link on a page, as stored. The website works out the platform, host and label to show. */
export class PageLink {
  /** An absolute https URL. Never rendered as markup. */
  url!: string;
  /** The label its owner gave it, for links added on vrc.page. */
  @ApiProperty({ type: String, nullable: true })
  label!: string | null;
  @ApiProperty({ enum: ['vrchat', 'vrcpage'], description: "vrchat: from the VRChat bio or group. vrcpage: added on vrc.page." })
  source!: 'vrchat' | 'vrcpage';
}

export class RepresentedGroup {
  id!: string;
  name!: string;
  /** The group's own vrc.page, only while that page is public. */
  @ApiProperty({ type: String, nullable: true })
  slug!: string | null;
}

/** A VRChat user's page. Fields VRChat didn't give are null, never a placeholder. */
export class UserPage {
  vrchatUserId!: string;
  displayName!: string;
  @ApiProperty({ type: String, nullable: true })
  pronouns!: string | null;
  ageVerified!: boolean;
  @ApiProperty({ type: String, nullable: true })
  trustRank!: string | null;
  @ApiProperty({ type: RepresentedGroup, nullable: true })
  group!: RepresentedGroup | null;
  @ApiProperty({ enum: ['active', 'join_me', 'ask_me', 'busy', 'offline'] })
  status!: 'active' | 'join_me' | 'ask_me' | 'busy' | 'offline';
  @ApiProperty({ type: String, nullable: true })
  statusDescription!: string | null;
  /** Plain text with its line breaks. */
  @ApiProperty({ type: String, nullable: true })
  bio!: string | null;
  /** VRChat's first, then the ones added on vrc.page, in their order. */
  links!: PageLink[];
  languages!: string[];
  /** Our own copy, never a VRChat address. Null until images are stored. */
  @ApiProperty({ type: String, nullable: true })
  bannerUrl!: string | null;
  @ApiProperty({ type: String, nullable: true })
  avatarUrl!: string | null;
  /** When the bio code matched: ISO 8601. */
  verifiedAt!: string;
  /** Last successful read from VRChat: ISO 8601. */
  lastRefreshedAt!: string;
  @ApiProperty({ enum: ['public', 'unlisted', 'private'] })
  visibility!: 'public' | 'unlisted' | 'private';
}

export class GroupOwner {
  displayName!: string;
  /** The owner's own vrc.page, only while that page is public. */
  @ApiProperty({ type: String, nullable: true })
  slug!: string | null;
}

/** A claimed VRChat group's page. */
export class GroupPage {
  vrchatGroupId!: string;
  name!: string;
  /** Shown with the discriminator as ABCDE.1234, the code VRChat uses. */
  shortCode!: string;
  discriminator!: string;
  @ApiProperty({ type: String, nullable: true })
  description!: string | null;
  @ApiProperty({ type: String, nullable: true })
  rules!: string | null;
  links!: PageLink[];
  languages!: string[];
  @ApiProperty({ type: 'integer' })
  memberCount!: number;
  /** VRChat's own verification. */
  isVerified!: boolean;
  @ApiProperty({ type: String, nullable: true })
  iconUrl!: string | null;
  @ApiProperty({ type: String, nullable: true })
  bannerUrl!: string | null;
  @ApiProperty({ type: GroupOwner, nullable: true })
  owner!: GroupOwner | null;
  /** When the claim succeeded: ISO 8601. */
  verifiedAt!: string;
  lastRefreshedAt!: string;
  @ApiProperty({ enum: ['public', 'unlisted', 'private'] })
  visibility!: 'public' | 'unlisted' | 'private';
}

/**
 * What vrc.page/<name> shows. A private, hidden, held or unknown name is one
 * identical 404, so this can't be used to find out whether a page exists.
 */
export class PublicPage {
  @ApiProperty({ enum: ['user', 'group'] })
  kind!: 'user' | 'group';
  /** The page's own name, as its owner typed it. */
  slug!: string;
  /** The name asked for is an alias: redirect (308) to `slug`. */
  alias!: boolean;
  @ApiProperty({ type: UserPage, required: false })
  user?: UserPage;
  @ApiProperty({ type: GroupPage, required: false })
  group?: GroupPage;
}

/** One page in the dashboard's navigation. */
export class DashboardPage {
  /** vrc.page's page id, used in dashboard addresses. */
  id!: string;
  @ApiProperty({ enum: ['user', 'group'] })
  kind!: 'user' | 'group';
  name!: string;
  /** Null until a name is chosen. */
  @ApiProperty({ type: String, nullable: true })
  slug!: string | null;
  @ApiProperty({ enum: ['public', 'unlisted', 'private'] })
  visibility!: 'public' | 'unlisted' | 'private';
  @ApiProperty({ enum: ['owner', 'editor'] })
  role!: 'owner' | 'editor';
  @ApiProperty({ type: String, nullable: true })
  iconUrl!: string | null;
  /** The usr_ or grp_ id, which seeds the fallback colour. */
  vrchatId!: string;
  /** Groups only. */
  @ApiProperty({ type: 'integer', nullable: true })
  memberCount!: number | null;
}

/** Everything the dashboard's frame shows about the signed-in account. */
export class Dashboard {
  @ApiProperty({ type: DashboardPage, nullable: true })
  user!: DashboardPage | null;
  /** Owned groups first, then the ones this account edits. */
  groups!: DashboardPage[];
  /** More groups this account may still claim. */
  @ApiProperty({ type: 'integer' })
  groupClaimsLeft!: number;
  @ApiProperty({ type: 'integer' })
  pendingInvites!: number;
}

/** The signed-in account's own page, whatever its visibility. */
export class OwnUserPage {
  pageId!: string;
  @ApiProperty({ type: String, nullable: true })
  slug!: string | null;
  /** When the page's name may next change: ISO 8601, or null when it can now. */
  @ApiProperty({ type: String, nullable: true })
  nameChangeableAt!: string | null;
  /** When it may next be refreshed from VRChat by hand: ISO 8601, or null when it can now. */
  @ApiProperty({ type: String, nullable: true })
  refreshableAt!: string | null;
  page!: UserPage;
}

/** A group page the signed-in account owns or edits. */
export class OwnGroupPage {
  pageId!: string;
  @ApiProperty({ type: String, nullable: true })
  slug!: string | null;
  @ApiProperty({ enum: ['owner', 'editor'] })
  role!: 'owner' | 'editor';
  /** When the page's name may next change: ISO 8601, or null when it can now. */
  @ApiProperty({ type: String, nullable: true })
  nameChangeableAt!: string | null;
  /** When it may next be refreshed from VRChat by hand: ISO 8601, or null when it can now. */
  @ApiProperty({ type: String, nullable: true })
  refreshableAt!: string | null;
  page!: GroupPage;
}

/** What a manual refresh did. */
export class Refreshed {
  /** ISO 8601. */
  refreshedAt!: string;
}

/** Which emails the account gets. No row in the database means these defaults. */
export class NotificationPreferences {
  /** Someone invited you to edit a group. */
  groupInvites!: boolean;
  /** Your page's name, visibility or links changed. */
  pageChanges!: boolean;
  /** Occasional news about vrc.page itself. */
  productNews!: boolean;
}

/** Who can open a page. */
export class VisibilityRequest {
  @ApiProperty({ enum: ['public', 'unlisted', 'private'] })
  visibility!: 'public' | 'unlisted' | 'private';
}

/** The preferences to change; the ones left out stay as they are. */
export class NotificationPreferencesPatch {
  @ApiProperty({ required: false })
  groupInvites?: boolean;
  @ApiProperty({ required: false })
  pageChanges?: boolean;
  @ApiProperty({ required: false })
  productNews?: boolean;
}

/** Whether a name can be given to a page. */
export class NameAvailability {
  @ApiProperty({
    enum: ['available', 'yours', 'taken', 'held', 'reserved', 'impersonation', 'invalid', 'too_short', 'too_long'],
    description:
      'available: free. yours: this page already has it. taken: another page has it. held: released recently and still held. ' +
      'reserved: a name the site keeps. impersonation: contains a blocked word. invalid: not letters, digits, _ or -.',
  })
  status!: 'available' | 'yours' | 'taken' | 'held' | 'reserved' | 'impersonation' | 'invalid' | 'too_short' | 'too_long';
  @ApiProperty({ type: 'integer' })
  minLength!: number;
  @ApiProperty({ type: 'integer' })
  maxLength!: number;
}

/** The name to give a page. */
export class NameRequest {
  name!: string;
}

/** A page's name, as it was taken. */
export class PageName {
  slug!: string;
}
