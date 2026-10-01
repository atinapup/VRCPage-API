/*
 * Our copies of VRChat icons and banners (spec section 7: never hotlink
 * VRChat's CDN, never touch a VRChat domain from a public page).
 *
 * A snapshot's pictures are fetched and re-encoded before its transaction
 * opens, because a download can take seconds and nothing should hold locks
 * that long. Inside the transaction they become rows in vrchat.images and ids
 * on the user or group, so the picture and the page change together.
 *
 *   stored as   WebP, fitted inside ICON_BOX or BANNER_BOX, in the database
 *   named by    the sha256 of those bytes, so two users with the same picture
 *               share one row
 *   reused      when VRChat gives an address already stored: no download
 *   kept        when a download fails: the old picture beats none
 *   deleted     by the database, the moment no user, group or page uses it
 *               (migrations 20260929130000, 20261002090300)
 *   served at   /images/<sha256 hex>.webp on the website, which asks
 *               images.controller.ts
 */
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Kysely } from 'kysely';
import sharp from 'sharp';
import { Database } from '../database/database.js';
import type { DB } from '../database/database.types.js';
import { VRChatClient } from './client.js';

/** Icons are shown at most ~200px wide; this covers a 2x screen with room to spare. */
const ICON_BOX = 512;
/** Banners fill a card about 800px wide. */
const BANNER_BOX = 1600;
/** WebP quality: indistinguishable from the original at these sizes. */
const QUALITY = 82;
/** Larger than any real icon or banner; refuses decompression bombs. */
const MAX_PIXELS = 50_000_000;

/** A picture downloaded and encoded, not yet saved. */
type Encoded = { sourceUrl: string; sha256: Buffer; bytes: Buffer; width: number; height: number };

/**
 * What one picture column should become: an image already stored, a new one,
 * none (VRChat has no picture), or left as it is (undefined: it couldn't be
 * fetched this time).
 */
type Picture = { id: string } | Encoded | null | undefined;

export type Pictures = { icon: Picture; banner: Picture };

/**
 * A banner someone uploaded on vrc.page, made like a VRChat one: upright,
 * fitted inside BANNER_BOX, WebP. The first frame of an animation. Null when
 * sharp can't read it as a picture.
 */
export async function encodeUploadedBanner(original: Buffer): Promise<{ sha256: Buffer; bytes: Buffer; width: number; height: number } | null> {
  try {
    const { data, info } = await sharp(original, { limitInputPixels: MAX_PIXELS })
      .rotate()
      .resize({ width: BANNER_BOX, height: BANNER_BOX, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { sha256: createHash('sha256').update(data).digest(), bytes: data, width: info.width, height: info.height };
  } catch {
    return null;
  }
}

/** Store an uploaded picture, or find the same bytes already stored. Its id. */
export async function saveUploadedImage(trx: Kysely<DB>, picture: { sha256: Buffer; bytes: Buffer; width: number; height: number }): Promise<string> {
  const row = await trx
    .insertInto('vrchat.images')
    .values({ sha256: picture.sha256, width: picture.width, height: picture.height, byteSize: picture.bytes.length, bytes: picture.bytes, sourceUrl: null })
    // Same bytes as a picture already stored: share it, changing nothing.
    .onConflict((oc) => oc.column('sha256').doUpdateSet((eb) => ({ sourceUrl: eb.ref('vrchat.images.sourceUrl') })))
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Where the website serves a stored picture. Relative: it is the website's own address. */
export function imagePath(sha256: Buffer | null): string | null {
  return sha256 ? `/images/${sha256.toString('hex')}.webp` : null;
}

@Injectable()
export class VRChatImages {
  private readonly logger = new Logger(VRChatImages.name);

  constructor(
    private readonly db: Database,
    private readonly client: VRChatClient,
  ) {}

  /** Fetch whatever a snapshot points at that isn't stored yet. Call before the transaction. */
  async fetch(snapshot: { iconUrl: string | null; bannerUrl: string | null }): Promise<Pictures> {
    const [icon, banner] = await Promise.all([this.one(snapshot.iconUrl, ICON_BOX), this.one(snapshot.bannerUrl, BANNER_BOX)]);
    return { icon, banner };
  }

  /**
   * The picture columns for the user or group row, saving new pictures first.
   * A column that couldn't be fetched is left out, so an update keeps it.
   */
  async columns(trx: Kysely<DB>, pictures: Pictures): Promise<{ iconImageId?: string | null; bannerImageId?: string | null }> {
    const [icon, banner] = await Promise.all([this.save(trx, pictures.icon), this.save(trx, pictures.banner)]);
    return { ...(icon !== undefined && { iconImageId: icon }), ...(banner !== undefined && { bannerImageId: banner }) };
  }

  private async one(url: string | null, box: number): Promise<Picture> {
    if (!url) return null;
    const known = await this.db.selectFrom('vrchat.images').select('id').where('sourceUrl', '=', url).executeTakeFirst();
    if (known) return known;

    const original = await this.client.download(url);
    if (!original) return undefined;
    try {
      const { data, info } = await sharp(original, { limitInputPixels: MAX_PIXELS })
        .rotate()
        .resize({ width: box, height: box, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: QUALITY })
        .toBuffer({ resolveWithObject: true });
      return { sourceUrl: url, sha256: createHash('sha256').update(data).digest(), bytes: data, width: info.width, height: info.height };
    } catch (error) {
      this.logger.warn(`A picture from VRChat is not one sharp can read (${error instanceof Error ? error.message : String(error)}): ${url}`);
      return undefined;
    }
  }

  private async save(trx: Kysely<DB>, picture: Picture): Promise<string | null | undefined> {
    if (picture === null || picture === undefined) return picture;
    if ('id' in picture) return picture.id;
    const row = await trx
      .insertInto('vrchat.images')
      .values({ sha256: picture.sha256, width: picture.width, height: picture.height, byteSize: picture.bytes.length, bytes: picture.bytes, sourceUrl: picture.sourceUrl })
      // Same bytes as a picture someone already has: share it, and remember
      // this address too so the next refresh finds it.
      .onConflict((oc) => oc.column('sha256').doUpdateSet({ sourceUrl: picture.sourceUrl }))
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}
