import { Global, Module } from '@nestjs/common';
import { Database } from './database.js';

@Global()
@Module({
  providers: [Database],
  exports: [Database],
})
export class DatabaseModule {}
