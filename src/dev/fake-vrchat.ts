/*
 * Test VRChat records, standing in for the real client in development.
 *
 *   Mira     the account to connect. Owns four public groups and a private
 *            one, so a claim succeeds three times and is refused the fourth.
 *   Juniper  a second account, to invite as an editor.
 *   Orin     owns Night Shift, and sends the invite.
 */

export type FakeUser = {
  id: string;
  displayName: string;
  bio: string;
  bioLinks: string[];
  pronouns: string | null;
  status: 'active' | 'join_me' | 'ask_me' | 'busy' | 'offline';
  isAgeVerified: boolean;
  trustRank: string | null;
  representedGroup: { id: string; name: string } | null;
  languages: string[];
};

export type FakeGroup = {
  id: string;
  name: string;
  shortCode: string;
  discriminator: string;
  ownerId: string;
  description: string;
  rules: string | null;
  links: string[];
  languages: string[];
  memberCount: number;
  isVerified: boolean;
  privacy: 'default' | 'private';
};

export const FAKE_IDS = {
  mira: 'usr_4e8b2d17-9c3a-4f61-b5d0-7a2e1c9f8b34',
  juniper: 'usr_b61f0a93-2d4e-4c87-8e15-3f9a6d2b7c05',
  orin: 'usr_0d3c7b58-6a19-4e2f-9b84-c5e1f2a7d690',
  nightMarket: 'grp_1a7c3e95-8b2d-4f06-a3e1-9c4d7b2f5e80',
  lantern: 'grp_6d2e9f41-3c7a-4b58-8e90-1f5b2c6a7d33',
  starfall: 'grp_c8f4a2b6-1e9d-4c37-a5f0-6b3d8e2a9c71',
  tidepool: 'grp_2f9a6c14-7d3b-4e85-b1c2-8a0e5d9f3b62',
  quietRoom: 'grp_9b3d5e27-4a1c-4f68-8d2e-0c7f1a6b4e19',
  nightShift: 'grp_7e4b1d93-5c2a-4f80-9e36-d1a8c5b2f704',
} as const;

const user = (fields: Pick<FakeUser, 'id' | 'displayName'> & Partial<FakeUser>): FakeUser => ({
  bio: '',
  bioLinks: [],
  pronouns: null,
  status: 'offline',
  isAgeVerified: false,
  trustRank: null,
  representedGroup: null,
  languages: [],
  ...fields,
});

const group = (fields: Pick<FakeGroup, 'id' | 'name' | 'shortCode' | 'discriminator' | 'ownerId'> & Partial<FakeGroup>): FakeGroup => ({
  description: '',
  rules: null,
  links: [],
  languages: [],
  memberCount: 0,
  isVerified: false,
  privacy: 'default',
  ...fields,
});

export const FAKE_USERS: Record<'mira' | 'juniper' | 'orin', FakeUser> = {
  mira: user({
    id: FAKE_IDS.mira,
    displayName: 'Mira',
    bio: 'Runs Night Market on Saturdays.\nAvatar vendor, occasional DJ.',
    bioLinks: ['https://www.twitch.tv/miravr', 'https://ko-fi.com/miravr'],
    pronouns: 'she/her',
    status: 'join_me',
    isAgeVerified: true,
    trustRank: 'Trusted User',
    representedGroup: { id: FAKE_IDS.nightMarket, name: 'Night Market' },
    languages: ['English', 'Nederlands'],
  }),
  juniper: user({
    id: FAKE_IDS.juniper,
    displayName: 'Juniper',
    bio: 'Builds worlds, occasionally finishes one.',
    status: 'active',
    trustRank: 'Known User',
    languages: ['English'],
  }),
  orin: user({ id: FAKE_IDS.orin, displayName: 'Orin', status: 'busy', trustRank: 'Veteran User' }),
};

export const FAKE_GROUPS: FakeGroup[] = [
  group({
    id: FAKE_IDS.nightMarket,
    name: 'Night Market',
    shortCode: 'NIGHT',
    discriminator: '2048',
    ownerId: FAKE_IDS.mira,
    description: 'A weekly market for avatar creators and world builders. Saturdays from 20:00 UTC in the Lantern District.',
    rules: 'Be kind to vendors.\nNo reselling free assets.\nAsk before recording.',
    links: ['https://discord.gg/nightmarket', 'https://nightmarket.events'],
    languages: ['English', 'Deutsch'],
    memberCount: 1204,
  }),
  group({
    id: FAKE_IDS.lantern,
    name: 'Lantern Collective',
    shortCode: 'LANTN',
    discriminator: '0417',
    ownerId: FAKE_IDS.mira,
    description: 'World builders sharing lighting setups and bake tricks.',
    languages: ['English'],
    memberCount: 342,
    isVerified: true,
  }),
  group({
    id: FAKE_IDS.starfall,
    name: 'Starfall Dance Club',
    shortCode: 'STARF',
    discriminator: '7731',
    ownerId: FAKE_IDS.mira,
    description: 'Full body dance nights, every second Friday.',
    memberCount: 88,
  }),
  group({
    id: FAKE_IDS.tidepool,
    name: 'Tidepool',
    shortCode: 'TIDEP',
    discriminator: '5102',
    ownerId: FAKE_IDS.mira,
    description: 'Quiet hangouts by the water.',
    memberCount: 51,
  }),
  group({
    id: FAKE_IDS.quietRoom,
    name: 'Quiet Room',
    shortCode: 'QUIET',
    discriminator: '0009',
    ownerId: FAKE_IDS.mira,
    description: 'Invite only.',
    privacy: 'private',
    memberCount: 12,
  }),
  group({
    id: FAKE_IDS.nightShift,
    name: 'Night Shift',
    shortCode: 'NSHFT',
    discriminator: '3310',
    ownerId: FAKE_IDS.orin,
    description: 'Late night events for the other side of the world.',
    memberCount: 5210,
    isVerified: true,
  }),
];
