import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminModule } from './admin/admin.module.js';
import { AuditModule } from './audit/audit.js';
import { AuthModule } from './auth/auth.module.js';
import { RateLimitGuard } from './common/rate-limit.js';
import { environment } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DevModule } from './dev/dev.module.js';
import { HealthModule } from './health/health.module.js';
import { MailModule } from './mail/mail.module.js';
import { NewsModule } from './news/news.module.js';
import { PagesModule } from './pages/pages.module.js';
import { VRChatModule } from './vrchat/vrchat.module.js';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuditModule,
    MailModule,
    AuthModule,
    HealthModule,
    PagesModule,
    NewsModule,
    AdminModule,
    VRChatModule,
    // Test-data shortcuts. Never registered in production, so those routes don't exist there.
    ...(environment === 'development' ? [DevModule] : []),
  ],
  // Every route is rate limited unless it says otherwise (src/common/rate-limit.ts).
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class AppModule {}
