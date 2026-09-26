import { Module } from '@nestjs/common';
import { PagesModule } from '../pages/pages.module.js';
import { DevController } from './dev.controller.js';

/** Development-only shortcuts. src/app.module.ts leaves this out in production. */
@Module({ imports: [PagesModule], controllers: [DevController] })
export class DevModule {}
