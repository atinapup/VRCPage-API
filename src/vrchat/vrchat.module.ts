import { Module } from '@nestjs/common';
import { ClaimsController } from './claims.controller.js';
import { ClaimsService } from './claims.service.js';
import { VRChatClient } from './client.js';
import { ImagesController } from './images.controller.js';
import { VRChatImages } from './images.js';
import { VRChatReader } from './reader.js';

/**
 * Everything that talks to VRChat. The reader and the image store are
 * exported because pages refresh from VRChat too; the client is not, so there
 * is exactly one way to make a call and it goes through the rules in client.ts.
 */
@Module({
  controllers: [ClaimsController, ImagesController],
  providers: [ClaimsService, VRChatClient, VRChatImages, VRChatReader],
  exports: [ClaimsService, VRChatImages, VRChatReader],
})
export class VRChatModule {}
