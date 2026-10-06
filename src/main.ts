import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { toNodeHandler } from 'better-auth/node';
import type { Express, NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { Audit } from './audit/audit.js';
import { AuthService } from './auth/auth.service.js';
import { buildOpenApiDocument, configureRoutes } from './app.setup.js';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { UPLOAD_LIMIT, UPLOAD_TYPES } from './common/upload.js';
import { fromWebsite, requestId } from './common/request-id.js';
import { AppConfig, loadEnvironmentFile } from './config/app-config.js';

loadEnvironmentFile();

// rawBody: the Resend webhook is signed over the bytes as they arrived,
// so re-serialising the parsed JSON would fail every signature.
const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
const config = app.get(AppConfig);
const express = app.getHttpAdapter().getInstance() as Express;
express.disable('x-powered-by');

// Only the website may call the API (docs/api.md, "Sign-in"). Anything
// without the shared secret gets the answer a missing route would, except the
// health checks load balancers make.
app.use(fromWebsite(config.apiSecret));
app.use(requestId);
// Uploads (a page's banner, the media in "What's new") arrive as the file's
// own bytes, with its type as the Content-Type. Only these types are read
// this way, and never more than UPLOAD_LIMIT; src/common/upload.ts checks
// what the bytes really are.
app.useBodyParser('raw', { type: UPLOAD_TYPES, limit: UPLOAD_LIMIT });
// Every answer is JSON for the website's server or a redirect: nothing a
// browser should sniff or a cache should keep.
app.use((request: Request, response: Response, next: NextFunction) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (!request.path.startsWith('/docs')) response.setHeader('Cache-Control', 'no-store');
  next();
});

// Better Auth's own endpoints, which the website proxies from its /api/auth/*:
// the Discord and GitHub callbacks (and the error page they can land on), and
// the header's "am I signed in" check. Nothing else of Better Auth's is served:
// every change goes through /v1/auth, where it is rate limited and audited.
// Registered here, ahead of the body parsers Nest adds on start, which would
// consume the body Better Auth reads itself. The instance only exists once the
// app has started, hence the lookup.
const BETTER_AUTH_PATHS = /^\/api\/auth\/(get-session|error|callback\/(discord|github))$/;
const auth = app.get(AuthService);
let authHandler: ReturnType<typeof toNodeHandler> | undefined;
express.get('/api/auth/*splat', (request, response) => {
  if (!BETTER_AUTH_PATHS.test(request.path)) return void response.status(404).end();
  authHandler ??= toNodeHandler(auth.auth);
  return authHandler(request, response);
});
app.useGlobalFilters(new ProblemDetailsFilter(app.get(Audit)));
app.enableShutdownHooks();
configureRoutes(app);

// Interactive docs in development only. The contract itself is openapi.json.
if (config.environment === 'development') {
  SwaggerModule.setup('docs', app, buildOpenApiDocument(app), { jsonDocumentUrl: 'docs/openapi.json' });
}

await app.listen(config.port);
console.log(`vrc.page API (${config.environment}) on http://localhost:${config.port}`);
if (config.environment === 'development') console.log(`Docs: http://localhost:${config.port}/docs`);
