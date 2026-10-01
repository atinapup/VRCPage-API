/*
 * What vrc.page keeps of a VRChat user or group.
 *
 * This is the shape both readers answer with: the real client in `client.ts`
 * and the test records in `fake-reader.ts`. It is deliberately narrower than
 * what VRChat returns. Everything here is shown on a page or needed to decide
 * who may claim what; nothing else is read, stored, or asked for.
 */

export type VRChatUserStatus = 'active' | 'join_me' | 'ask_me' | 'busy' | 'offline';

export type VRChatUser = {
  id: string;
  displayName: string;
  /** Where a vrcpage- code is looked for when connecting an account. */
  bio: string;
  bioLinks: string[];
  pronouns: string | null;
  /**
   * Null when the read didn't say. VRChat's profile endpoint only tells a
   * profile's owner their status, so a read of someone else's has none;
   * VRChatPresence, from GET /users/{userId}, does.
   */
  status: VRChatUserStatus | null;
  statusDescription: string | null;
  /**
   * Only true when VRChat says the person is showing 18+ on their profile.
   * Someone who verified and chose to hide it reads as false here, because
   * that is their choice and this page is more public than VRChat's.
   */
  isAgeVerified: boolean;
  /** VRChat stopped sending this with the profile; VRChatPresence has it. */
  trustRank: string | null;
  representedGroup: { id: string; name: string } | null;
  languages: string[];
  iconUrl: string | null;
  bannerUrl: string | null;
};

/** What GET /users/{userId} still says that the profile no longer does. */
export type VRChatPresence = {
  status: VRChatUserStatus;
  /** The line the person wrote under their status. */
  statusDescription: string | null;
  /** VRChat's name for the person's trust level, such as "Known User". */
  trustRank: string | null;
};

export type VRChatGroup = {
  id: string;
  name: string;
  shortCode: string;
  discriminator: string;
  ownerId: string;
  /** Where a vrcpage- code is looked for when claiming a group. */
  description: string;
  rules: string | null;
  links: string[];
  languages: string[];
  memberCount: number;
  isVerified: boolean;
  privacy: 'default' | 'private';
  iconUrl: string | null;
  bannerUrl: string | null;
};

/**
 * Why a read gave nothing back.
 *
 *   not_found     VRChat has no such user or group, or it is hidden from us
 *   rate_limited  VRChat pushed back; the client is now waiting it out
 *   unavailable   VRChat failed, timed out, or refused our session
 *   busy          we did not call: another read has the slot, the lane is
 *                 spent for today, or the client is paused
 *
 * The first three are also `vrchat.fetch_error` in the database, because they
 * are things VRChat said. `busy` never reaches a row: nothing was asked.
 */
export type ReadFailure = 'not_found' | 'rate_limited' | 'unavailable' | 'busy';

export type ReadResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: ReadFailure;
      /** How long until this kind of read could be tried again, when that is known. */
      waitSeconds?: number;
    };

/** The queue a read is spent from (spec section 3). Each has its own daily share. */
export type Lane = 'verification' | 'scheduled' | 'manual' | 'headroom';
