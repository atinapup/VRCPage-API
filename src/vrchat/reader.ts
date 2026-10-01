/*
 * Where a read of VRChat comes from.
 *
 * One door, so nothing else in the API has to know whether it is talking to
 * VRChat or to the test records. With an account in the environment it is the
 * real client, with all of section 2's rules. Without one, development reads
 * the records in fake-reader.ts, and anything else gets nothing and says so.
 *
 * Every caller names the lane it is spending from, because there is no such
 * thing as a read that doesn't cost anything.
 */
import { Injectable, Logger } from '@nestjs/common';
import { environment } from '../config/app-config.js';
import { VRChatClient } from './client.js';
import { fakeReader } from './fake-reader.js';
import type { Lane, ReadResult, VRChatGroup, VRChatPresence, VRChatUser } from './types.js';

/** What a read answers when there is nothing to read with. */
const NOTHING_TO_READ_WITH = { ok: false, reason: 'unavailable' } as const;

@Injectable()
export class VRChatReader {
  private readonly logger = new Logger(VRChatReader.name);

  constructor(private readonly client: VRChatClient) {}

  /** True when reads reach VRChat itself rather than the test records. */
  get live(): boolean {
    return this.client.configured;
  }

  async getUser(lane: Lane, id: string, jobId?: string): Promise<ReadResult<VRChatUser>> {
    if (this.client.configured) return this.client.getUser(lane, id, jobId);
    if (environment === 'development') return fakeReader.getUser(id);
    this.warn();
    return NOTHING_TO_READ_WITH;
  }

  /** Status, status line and trust rank, which the profile only gives its owner. */
  async getUserStatus(lane: Lane, id: string, jobId?: string): Promise<ReadResult<VRChatPresence>> {
    if (this.client.configured) return this.client.getUserStatus(lane, id, jobId);
    if (environment === 'development') return fakeReader.getUserStatus(id);
    this.warn();
    return NOTHING_TO_READ_WITH;
  }

  async getGroup(lane: Lane, id: string, jobId?: string): Promise<ReadResult<VRChatGroup>> {
    if (this.client.configured) return this.client.getGroup(lane, id, jobId);
    if (environment === 'development') return fakeReader.getGroup(id);
    this.warn();
    return NOTHING_TO_READ_WITH;
  }

  private warn(): void {
    this.logger.warn('A read of VRChat was asked for with no account configured. Set VRCHAT_USERNAME, VRCHAT_PASSWORD and VRCHAT_TOTP_SECRET.');
  }
}
