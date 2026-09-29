import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { HealthController } from './health.controller.js';

@Module({
  // Readiness checks Better Auth's database login as well as the API's.
  imports: [AuthModule],
  controllers: [HealthController],
})
export class HealthModule {}
