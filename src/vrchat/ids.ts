/*
 * Reading a VRChat user or group out of whatever someone pastes: a profile
 * link, a bare id, or the wrong thing entirely. The website checks the same
 * shapes as you type; this is the check that counts.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** usr_ followed by a UUID, the current VRChat format. */
const USER_ID = new RegExp(`^usr_${UUID}$`, 'i');
/** Accounts from before the usr_ format have a ten character id. */
const LEGACY_USER_ID = /^[A-Za-z0-9]{10}$/;
const GROUP_ID = new RegExp(`^grp_${UUID}$`, 'i');
/** A group's short code and discriminator, as in vrc.group/ABCDE.1234. */
const SHORT_CODE = /^[A-Za-z0-9]{3,6}\.\d{4}$/;

export type Ref =
  | { status: 'ok'; id: string }
  /** A group where a user belongs, or the other way round. */
  | { status: 'wrong_kind' }
  /** vrc.group/ABCDE.1234. Resolving it needs VRChat's search, which vrc.page never calls. */
  | { status: 'short_link' }
  | { status: 'invalid' };

/** The host and path segments of anything that looks like a link. */
function asLink(text: string): { host: string; parts: string[] } | null {
  if (!/[./]/.test(text)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return { host: url.hostname.toLowerCase().replace(/^www\./, ''), parts: url.pathname.split('/').filter(Boolean) };
  } catch {
    return null;
  }
}

/** The id as VRChat writes it: usr_ and grp_ ids lowercase, older ids as typed. */
function normalize(id: string): string {
  return /^(usr|grp)_/i.test(id) ? id.toLowerCase() : id;
}

export function parseUserRef(raw: string): Ref {
  const text = raw.trim();
  if (USER_ID.test(text) || LEGACY_USER_ID.test(text)) return { status: 'ok', id: normalize(text) };
  if (GROUP_ID.test(text)) return { status: 'wrong_kind' };
  if (SHORT_CODE.test(text)) return { status: 'short_link' };

  const link = asLink(text);
  if (!link) return { status: 'invalid' };
  if (link.host === 'vrc.group') return { status: 'short_link' };
  if (link.host !== 'vrchat.com') return { status: 'invalid' };

  const id = link.parts.at(-1) ?? '';
  if (USER_ID.test(id) || LEGACY_USER_ID.test(id)) return { status: 'ok', id: normalize(id) };
  if (GROUP_ID.test(id)) return { status: 'wrong_kind' };
  return { status: 'invalid' };
}

export function parseGroupRef(raw: string): Ref {
  const text = raw.trim();
  if (GROUP_ID.test(text)) return { status: 'ok', id: normalize(text) };
  if (USER_ID.test(text) || LEGACY_USER_ID.test(text)) return { status: 'wrong_kind' };
  if (SHORT_CODE.test(text)) return { status: 'short_link' };

  const link = asLink(text);
  if (!link) return { status: 'invalid' };
  if (link.host === 'vrc.group') return { status: 'short_link' };
  if (link.host !== 'vrchat.com') return { status: 'invalid' };

  const id = link.parts.at(-1) ?? '';
  if (GROUP_ID.test(id)) return { status: 'ok', id: normalize(id) };
  if (USER_ID.test(id) || LEGACY_USER_ID.test(id)) return { status: 'wrong_kind' };
  return { status: 'invalid' };
}
