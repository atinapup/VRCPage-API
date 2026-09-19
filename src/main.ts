import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { buildOpenApiDocument, configureRoutes } from './app.setup.js';
import { ProblemDetailsFilter } from './common/problem-details.filter.js';
import { requestId } from './common/request-id.js';
import { AppConfig, loadEnvironmentFile } from './config/app-config.js';

loadEnvironmentFile();

const app = await NestFactory.create(AppModule);
const config = app.get(AppConfig);

app.use(requestId);
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
