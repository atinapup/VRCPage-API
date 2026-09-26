import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.js';
import { AuthModule } from './auth/auth.module.js';
import { environment } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DevModule } from './dev/dev.module.js';
import { HealthModule } from './health/health.module.js';
import { MailModule } from './mail/mail.module.js';
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
    VRChatModule,
    // Test-data shortcuts. Never registered in production, so those routes don't exist there.
    ...(environment === 'development' ? [DevModule] : []),
  ],
})
export class AppModule {}
