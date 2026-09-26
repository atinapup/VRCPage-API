import { Module } from '@nestjs/common';
import { EditorsController } from './editors.controller.js';
import { EditorsService } from './editors.service.js';
import { LinksController } from './links.controller.js';
import { LinksService } from './links.service.js';
import { MeController, PagesController } from './pages.controller.js';
import { PagesService } from './pages.service.js';
import { RefreshService } from './refresh.service.js';

@Module({
  controllers: [PagesController, MeController, EditorsController, LinksController],
  providers: [PagesService, EditorsService, LinksService, RefreshService],
  exports: [PagesService],
})
export class PagesModule {}
