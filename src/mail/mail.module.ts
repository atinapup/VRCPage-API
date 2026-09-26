import { Global, Module } from '@nestjs/common';
import { MailController } from './mail.controller.js';
import { MailService } from './mail.service.js';

/**
 * Global, like Audit: several parts of the API send email, and none of them
 * should have to import a module to say so.
 */
@Global()
@Module({ controllers: [MailController], providers: [MailService], exports: [MailService] })
export class MailModule {}
