import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { toNodeHandler } from 'better-auth/node';
import type { Express } from 'express';
import { AppModule } from './app.module.js';
import { AuthService } from './auth/auth.service.js';
import { buildOpenApiDocument, configureRoutes } from './app.setup.js';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { requestId } from './common/request-id.js';
import { AppConfig, loadEnvironmentFile } from './config/app-config.js';

loadEnvironmentFile();

const app = await NestFactory.create(AppModule);
const config = app.get(AppConfig);

app.use(requestId);

// Better Auth's own endpoints, which the website proxies from its /api/auth/*:
// the Discord and GitHub callbacks, and the header's "am I signed in" check.
// Everything else goes through /v1/auth. Registered here, ahead of the body
// parsers Nest adds on start, which would consume the body Better Auth reads
// itself. The instance only exists once the app has started, hence the lookup.
const auth = app.get(AuthService);
let authHandler: ReturnType<typeof toNodeHandler> | undefined;
(app.getHttpAdapter().getInstance() as Express).all('/api/auth/*splat', (request, response) => {
  authHandler ??= toNodeHandler(auth.auth);
  return authHandler(request, response);
});
app.useGlobalFilters(new ProblemDetailsFilter());
app.enableCors({ origin: config.webOrigin, credentials: true, exposedHeaders: ['X-Request-Id'] });
app.enableShutdownHooks();
configureRoutes(app);

// Interactive docs in development only. The contract itself is openapi.json.
if (config.environment === 'development') {
  SwaggerModule.setup('docs', app, buildOpenApiDocument(app), { jsonDocumentUrl: 'docs/openapi.json' });
}

await app.listen(config.port);
console.log(`vrc.page API (${config.environment}) on http://localhost:${config.port}`);
if (config.environment === 'development') console.log(`Docs: http://localhost:${config.port}/docs`);
