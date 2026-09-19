import { Global, Module } from '@nestjs/common';
import { AppConfig } from './app-config.js';

@Global()
@Module({
  providers: [AppConfig],
  exports: [AppConfig],
})
export class ConfigModule {}
