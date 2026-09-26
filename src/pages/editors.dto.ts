import { ApiProperty } from '@nestjs/swagger';

/** Somebody who helps run a group, or who has been asked to. */
export class Editor {
  /**
   * This account, as this group's owner may refer to it. Opaque: it is only
   * ever used to take the seat away again.
   */
  id!: string;
  /** Their VRChat name, or null if they have disconnected VRChat since. */
  @ApiProperty({ type: String, nullable: true })
  name!: string | null;
  /** Their own page, if it has a name. */
  @ApiProperty({ type: String, nullable: true })
  slug!: string | null;
  @ApiProperty({ type: String, nullable: true })
  iconUrl!: string | null;
  /** When they took the seat, or when they were asked: ISO 8601. */
  since!: string;
  /** An invitation nobody has answered yet. */
  pending!: boolean;
}

/** Who runs a group, for its owner. */
export class GroupEditors {
  /** Seats taken, then invitations still waiting. */
  editors!: Editor[];
  /** Seats and waiting invitations together may not pass this. */
  @ApiProperty({ type: 'integer' })
  max!: number;
}

/** The page name of the person to ask. */
export class InviteRequest {
  /** Their vrc.page name, as in vrc.page/<name>. */
  name!: string;
}

/** An invitation waiting for this account's answer. */
export class Invitation {
  id!: string;
  /** The group being invited to. */
  groupName!: string;
  @ApiProperty({ type: String, nullable: true })
  groupSlug!: string | null;
  @ApiProperty({ type: String, nullable: true })
  groupIconUrl!: string | null;
  @ApiProperty({ type: 'integer', nullable: true })
  memberCount!: number | null;
  /** Who asked, by their VRChat name. */
  @ApiProperty({ type: String, nullable: true })
  invitedBy!: string | null;
  /** ISO 8601. */
  sentAt!: string;
}
