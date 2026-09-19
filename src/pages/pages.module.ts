import { Module } from '@nestjs/common';
import { MeController, PagesController } from './pages.controller.js';
import { PagesService } from './pages.service.js';

@Module({
  controllers: [PagesController, MeController],
  providers: [PagesService],
  exports: [PagesService],
})
export class PagesModule {}
