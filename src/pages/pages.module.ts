import { Module } from '@nestjs/common';
import { EditorsController } from './editors.controller.js';
import { EditorsService } from './editors.service.js';
import { LinksController } from './links.controller.js';
import { LinksService } from './links.service.js';
import { PageSettingsController, PreferencesController } from './page-settings.controller.js';
import { PageSettingsService } from './page-settings.service.js';
import { MeController, PagesController, ShowcaseController } from './pages.controller.js';
import { PagesService } from './pages.service.js';
import { RefreshService } from './refresh.service.js';
import { VRChatModule } from '../vrchat/vrchat.module.js';

@Module({
  // Refreshing a page is a read of VRChat, so it goes through the same door.
  imports: [VRChatModule],
  controllers: [PagesController, ShowcaseController, MeController, EditorsController, LinksController, PageSettingsController, PreferencesController],
  providers: [PagesService, EditorsService, LinksService, RefreshService, PageSettingsService],
  exports: [PagesService],
})
export class PagesModule {}
