import { Module } from '@nestjs/common';
import { DevController } from './dev.controller.js';

/** Development-only shortcuts. src/app.module.ts leaves this out in production. */
@Module({ controllers: [DevController] })
export class DevModule {}
