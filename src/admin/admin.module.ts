import { Module } from '@nestjs/common';
import { NewsModule } from '../news/news.module.js';
import { PagesModule } from '../pages/pages.module.js';
import { AdminUpdatesController } from './admin-updates.controller.js';
import { AdminController } from './admin.controller.js';
import { AdminGuard } from './admin.guard.js';
import { AdminService } from './admin.service.js';
import { LogsService } from './logs.service.js';

@Module({
  imports: [PagesModule, NewsModule],
  controllers: [AdminController, AdminUpdatesController],
  providers: [AdminService, AdminGuard, LogsService],
})
export class AdminModule {}
