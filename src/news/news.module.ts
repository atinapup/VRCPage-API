import { Module } from '@nestjs/common';
import { MyUpdatesController, NewsMediaController } from './news.controller.js';
import { NewsService } from './news.service.js';

/** "What's new": updates about vrc.page itself. Admins write them through /v1/admin/updates. */
@Module({
  controllers: [NewsMediaController, MyUpdatesController],
  providers: [NewsService],
  exports: [NewsService],
})
export class NewsModule {}
