/*
 * VRChat's answers, turned into ours.
 *
 * Kept apart from the client so the mapping can be read and tested without a
 * network or a session. VRChat's API is unofficial and changes without
 * notice, so every field here is treated as missing until proven otherwise:
 * a read that loses a field leaves that field empty rather than throwing away
 * the whole snapshot.
 *
 * The two endpoints vrc.page calls, and nothing else:
 *
 *   GET /profile/{userId}   the public profile
 *   GET /groups/{groupId}   a group
 *
 * The profile endpoint, not GET /users/{userId}: VRChat moved the bio onto
 * the profile, and the bio is where a vrcpage- code is pasted. It also
 * carries the represented group and the languages as plain arrays, so one
 * call does what would otherwise take two. The cost is `trustRank`, which
 * only the user endpoint still carries; a second call for a label is not a
 * good use of a budget of 1440 a day, so it stays empty.
 */
import type { VRChatGroup, VRChatUser, VRChatUserStatus } from './types.js';

export const VRCHAT_BASE_URL = 'https://api.vrchat.cloud/api/1';

export const ENDPOINTS = {
  user: (id: string) => `/profile/${encodeURIComponent(id)}`,
  group: (id: string) => `/groups/${encodeURIComponent(id)}`,
  /** Signs in with Basic auth and sets the `auth` cookie, which then still needs 2FA. */
  signIn: '/auth/user',
  /** Finishes that sign-in with an authenticator code. */
  verifyTotp: '/auth/twofactorauth/totp/verify',
} as const;

/** VRChat writes these with spaces; the database writes them with underscores. */
const STATUS: Record<string, VRChatUserStatus> = {
  active: 'active',
  'join me': 'join_me',
  'ask me': 'ask_me',
  busy: 'busy',
  offline: 'offline',
};

/*
 * The column limits from the vrchat schema. A snapshot is cut to fit rather
 * than refused: a bio one character over its limit must not cost someone
 * their whole page.
 */
const LIMITS = {
  displayName: 100,
  bio: 4000,
  pronouns: 100,
  statusDescription: 200,
  groupName: 200,
  description: 8000,
  rules: 16000,
  shortCode: 32,
  discriminator: 32,
  list: 20,
} as const;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function optionalText(value: unknown, max: number): string | null {
  const flat = text(value, max).trim();
  return flat === '' ? null : flat;
}

/** A string array, cut to the column's cardinality, with anything else dropped. */
function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, LIMITS.list);
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** An image address, kept only when it is one VRChat could actually have sent. */
function imageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The public profile, as `GET /profile/{userId}` gives it.
 *
 * 18+ comes from `ageVerificationStatus`, not from `ageVerified`: the first
 * says what the person shows on their profile, the second only that they went
 * through it. Someone who verified and set it to hidden is not shown as 18+
 * here either.
 */
export function readProfile(body: unknown, requestedId: string): VRChatUser | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;

  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : requestedId;
  const displayName = text(raw.displayName, LIMITS.displayName).trim();
  // A profile with no name is not a profile; anything else can be empty.
  if (displayName === '') return null;

  const group = typeof raw.representedGroup === 'object' && raw.representedGroup !== null ? (raw.representedGroup as Record<string, unknown>) : null;
  const groupId = typeof group?.id === 'string' ? group.id : null;

  return {
    id,
    displayName,
    bio: text(raw.bio, LIMITS.bio),
    bioLinks: list(raw.bioLinks),
    pronouns: optionalText(raw.pronouns, LIMITS.pronouns),
    status: STATUS[String(raw.status)] ?? 'offline',
    statusDescription: optionalText(raw.statusDescription, LIMITS.statusDescription),
    isAgeVerified: raw.ageVerificationStatus === '18+',
    trustRank: null,
    representedGroup: groupId ? { id: groupId, name: text(group?.name, LIMITS.groupName) } : null,
    languages: list(raw.languages),
    iconUrl: imageUrl(raw.iconUrl),
    bannerUrl: imageUrl(raw.bannerUrl),
  };
}

/**
 * A group, as `GET /groups/{groupId}` gives it.
 *
 * `ownerId` and `privacy` are the two that decide whether a page may exist at
 * all, so a group missing either is treated as unreadable rather than guessed
 * at: guessing `default` would publish a group someone made private.
 */
export function readGroup(body: unknown, requestedId: string): VRChatGroup | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;

  const name = text(raw.name, LIMITS.groupName).trim();
  const ownerId = typeof raw.ownerId === 'string' ? raw.ownerId : '';
  const privacy = raw.privacy === 'default' || raw.privacy === 'private' ? raw.privacy : null;
  if (name === '' || ownerId === '' || privacy === null) return null;

  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : requestedId,
    name,
    shortCode: text(raw.shortCode, LIMITS.shortCode),
    discriminator: text(raw.discriminator, LIMITS.discriminator),
    ownerId,
    description: text(raw.description, LIMITS.description),
    rules: optionalText(raw.rules, LIMITS.rules),
    links: list(raw.links),
    languages: list(raw.languages),
    memberCount: count(raw.memberCount),
    isVerified: raw.isVerified === true,
    privacy,
    iconUrl: imageUrl(raw.iconUrl),
    bannerUrl: imageUrl(raw.bannerUrl),
  };
}

/** The check: node --experimental-strip-types src/vrchat/api.ts */
if (/api\.[tj]s$/.test(process.argv[1] ?? '')) {
  let failures = 0;
  const check = (got: unknown, want: unknown, what: string): void => {
    const same = JSON.stringify(got) === JSON.stringify(want);
    if (same) return;
    failures++;
    console.error(`  FAILED: ${what}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
  };

  const USER = 'usr_4e8b2d17-9c3a-4f61-b5d0-7a2e1c9f8b34';
  const GROUP = 'grp_1a7c3e95-8b2d-4f06-a3e1-9c4d7b2f5e80';

  const profile = readProfile(
    {
      id: USER,
      displayName: 'Mira',
      bio: 'Runs Night Market. vrcpage-K7R2Q9',
      bioLinks: ['https://www.twitch.tv/miravr', '', 42],
      pronouns: ' she/her ',
      status: 'join me',
      statusDescription: 'at the market',
      ageVerificationStatus: '18+',
      ageVerified: true,
      representedGroup: { id: GROUP, name: 'Night Market' },
      languages: ['English', 'Nederlands'],
      iconUrl: 'https://api.vrchat.cloud/icon.png',
      bannerUrl: 'http://insecure.example/banner.png',
      tags: ['system_trust_veteran'],
    },
    USER,
  );
  check(profile?.status, 'join_me', 'a status with a space becomes one with an underscore');
  check(profile?.isAgeVerified, true, '18+ on the profile reads as verified');
  check(profile?.pronouns, 'she/her', 'pronouns are trimmed');
  check(profile?.bioLinks, ['https://www.twitch.tv/miravr'], 'empty and non-string links are dropped');
  check(profile?.representedGroup, { id: GROUP, name: 'Night Market' }, 'the represented group comes through');
  check(profile?.bannerUrl, null, 'a plain http image is refused');
  check(profile?.iconUrl, 'https://api.vrchat.cloud/icon.png', 'an https image is kept');
  check(profile?.trustRank, null, 'trust rank is not on the profile endpoint');

  const hidden = readProfile({ id: USER, displayName: 'Mira', ageVerificationStatus: 'hidden', ageVerified: true }, USER);
  check(hidden?.isAgeVerified, false, 'someone who hid their verification is not shown as 18+');
  check(hidden?.status, 'offline', 'a missing status falls back to offline');
  check(hidden?.bio, '', 'a missing bio is empty, not a failure');

  check(readProfile({ id: USER }, USER), null, 'a profile with no name is unreadable');
  check(readProfile(null, USER), null, 'a non-object body is unreadable');
  check(readProfile({ displayName: 'Mira' }, USER)?.id, USER, 'a missing id falls back to the one asked for');
  check(readProfile({ displayName: 'M', bio: 'x'.repeat(5000) }, USER)?.bio.length, 4000, 'a long bio is cut to the column');

  const group = readGroup(
    { id: GROUP, name: 'Night Market', shortCode: 'NIGHT', discriminator: '2048', ownerId: USER, privacy: 'default', memberCount: 1204.7, isVerified: true, rules: '  ' },
    GROUP,
  );
  check(group?.memberCount, 1204, 'a fractional member count is floored');
  check(group?.rules, null, 'blank rules are no rules');
  check(group?.isVerified, true, 'verified comes through');
  check(group?.privacy, 'default', 'privacy comes through');

  check(readGroup({ name: 'X', ownerId: USER }, GROUP), null, 'a group with no privacy is unreadable, never assumed public');
  check(readGroup({ name: 'X', privacy: 'default' }, GROUP), null, 'a group with no owner is unreadable');
  check(readGroup({ ownerId: USER, privacy: 'private' }, GROUP), null, 'a group with no name is unreadable');
  check(readGroup({ name: 'X', ownerId: USER, privacy: 'private' }, GROUP)?.privacy, 'private', 'a private group reads as private');

  check(ENDPOINTS.user(USER), `/profile/${USER}`, 'the user endpoint is the profile one');
  check(ENDPOINTS.group(GROUP), `/groups/${GROUP}`, 'the group endpoint');

  console.log(failures === 0 ? 'api: 22 checks pass' : `api: ${failures} of 22 checks FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
