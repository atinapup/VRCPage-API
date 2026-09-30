import { ApiProperty } from '@nestjs/swagger';
import { GroupPage, UserPage } from '../pages/pages.dto.js';

type Role = 'admin' | 'moderator' | 'partner';
const ROLES = ['admin', 'moderator', 'partner'];

/** One account in the admin list. */
export class AdminAccountRow {
  id!: string;
  email!: string;
  /** When it signed up: ISO 8601. */
  createdAt!: string;
  @ApiProperty({ enum: ROLES, isArray: true })
  roles!: Role[];
  /** The connected VRChat account's display name, or null before one is connected. */
  @ApiProperty({ type: String, nullable: true })
  vrchatName!: string | null;
  @ApiProperty({ type: String, nullable: true })
  vrchatId!: string | null;
  @ApiProperty({ type: String, nullable: true })
  avatarUrl!: string | null;
  /** Its own page's id and name, when it has one. */
  @ApiProperty({ type: String, nullable: true })
  pageId!: string | null;
  @ApiProperty({ type: String, nullable: true })
  slug!: string | null;
  /** Groups it owns. */
  @ApiProperty({ type: 'integer' })
  groups!: number;
}

export class AdminAccountList {
  accounts!: AdminAccountRow[];
  /** Pass as `before` for the next, older, page of results; null at the end. */
  @ApiProperty({ type: String, nullable: true })
  next!: string | null;
}

/** One page in the admin list. */
export class AdminPageRow {
  id!: string;
  @ApiProperty({ enum: ['user', 'group'] })
  kind!: 'user' | 'group';
  /** The VRChat display name or group name. */
  name!: string;
  @ApiProperty({ type: String, nullable: true })
  slug!: string | null;
  @ApiProperty({ enum: ['public', 'unlisted', 'private'] })
  visibility!: 'public' | 'unlisted' | 'private';
  /** Taken down by staff. */
  hidden!: boolean;
  vrchatId!: string;
  @ApiProperty({ type: String, nullable: true })
  iconUrl!: string | null;
  ownerAccountId!: string;
  ownerEmail!: string;
  createdAt!: string;
}

export class AdminPageList {
  pages!: AdminPageRow[];
  /** Pass as `before` for the next, older, page of results; null at the end. */
  @ApiProperty({ type: String, nullable: true })
  next!: string | null;
}

export class AdminSession {
  id!: string;
  createdAt!: string;
  expiresAt!: string;
  @ApiProperty({ type: String, nullable: true })
  ip!: string | null;
  @ApiProperty({ type: String, nullable: true })
  userAgent!: string | null;
}

export class AdminVRChatUser {
  id!: string;
  displayName!: string;
  connectedAt!: string;
}

/** Everything an admin sees about one account. */
export class AdminAccount {
  id!: string;
  email!: string;
  /** Can be empty: an email sign-up has no name. */
  name!: string;
  emailVerified!: boolean;
  createdAt!: string;
  @ApiProperty({ enum: ROLES, isArray: true })
  roles!: Role[];
  /** Discord and GitHub, when connected. */
  providers!: string[];
  /** Sessions that haven't expired, newest first. */
  sessions!: AdminSession[];
  @ApiProperty({ type: AdminVRChatUser, nullable: true })
  vrchat!: AdminVRChatUser | null;
  /** Its own page, then the groups it owns. */
  pages!: AdminPageRow[];
  /** Groups it helps run as an editor. */
  editing!: AdminPageRow[];
}

export class AdminAlias {
  /** The name, as typed. */
  slug!: string;
  /** True sends the visitor on to the page's own name; false shows the page here. */
  redirect!: boolean;
}

export class AdminHidden {
  at!: string;
  reason!: string;
}

/** One page, for an admin: the page itself, and what only staff can change. */
export class AdminPage {
  pageId!: string;
  @ApiProperty({ enum: ['user', 'group'] })
  kind!: 'user' | 'group';
  @ApiProperty({ type: String, nullable: true })
  slug!: string | null;
  @ApiProperty({ type: AdminHidden, nullable: true })
  hidden!: AdminHidden | null;
  ownerAccountId!: string;
  ownerEmail!: string;
  aliases!: AdminAlias[];
  /** Picked as an example for the home page. Only shown there while it is public. */
  showcase!: boolean;
  @ApiProperty({ type: UserPage, required: false })
  user?: UserPage;
  @ApiProperty({ type: GroupPage, required: false })
  group?: GroupPage;
}

export class AdminAccountPatch {
  email?: string;
  /** Up to 200 characters. Empty clears it. */
  name?: string;
}

export class HideRequest {
  /** Why, for staff. Up to 1000 characters. */
  reason!: string;
}

export class AliasRequest {
  name!: string;
  /** Defaults to true: the alias sends visitors on to the page's own name. */
  redirect?: boolean;
}

export class AliasPatch {
  redirect!: boolean;
}
