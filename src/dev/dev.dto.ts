import { ApiProperty } from '@nestjs/swagger';

/** A code printed to the API's terminal, for the website's development page. */
export class SentCode {
  email!: string;
  code!: string;
  @ApiProperty({ enum: ['sign-in', 'change-email'] })
  purpose!: 'sign-in' | 'change-email';
  /** ISO 8601. */
  sentAt!: string;
}

/** Which test VRChat user to connect the signed-in account to. */
export class DevConnectRequest {
  @ApiProperty({ enum: ['mira', 'juniper'] })
  as!: 'mira' | 'juniper';
}

/** A test VRChat user, as the development page shows it. */
export class FakeUserView {
  id!: string;
  displayName!: string;
  /** Where a vrcpage- code is looked for. */
  bio!: string;
}

/** A test VRChat group, as the development page shows it. */
export class FakeGroupView {
  id!: string;
  name!: string;
  shortCode!: string;
  discriminator!: string;
  ownerId!: string;
  /** Where a vrcpage- code is looked for. */
  description!: string;
  @ApiProperty({ enum: ['default', 'private'] })
  privacy!: 'default' | 'private';
  @ApiProperty({ type: 'integer' })
  memberCount!: number;
}

/** The stand-in VRChat, as the development page shows it. */
export class FakeWorldView {
  users!: FakeUserView[];
  groups!: FakeGroupView[];
  @ApiProperty({ enum: ['none', 'rate_limited', 'unavailable'], description: 'How reads answer: normally, or as VRChat does when it pushes back.' })
  reads!: 'none' | 'rate_limited' | 'unavailable';
}

/** New text for a test bio or description: where a code gets "pasted into VRChat". */
export class FakeTextRequest {
  text!: string;
}

/** How the stand-in reader should answer. */
export class FakeReadsRequest {
  @ApiProperty({ enum: ['none', 'rate_limited', 'unavailable'] })
  reads!: 'none' | 'rate_limited' | 'unavailable';
}
