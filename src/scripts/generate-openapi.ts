// Writes the API contract to openapi.json, or with --check fails when the
// committed file is out of date (for CI). Runs Nest in preview mode: routes and
// DTOs are read, but no provider is created, so it needs no database or .env.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { buildOpenApiDocument, configureRoutes } from '../app.setup.js';

const SPEC_FILE = 'openapi.json';

const app = await NestFactory.create(AppModule, { preview: true, logger: false });
configureRoutes(app);
const document = buildOpenApiDocument(app);
await app.close();

const spec = `${JSON.stringify(document, null, 2)}\n`;
const operations = Object.values(document.paths).reduce((count, path) => count + Object.keys(path).length, 0);

if (process.argv.includes('--check')) {
  const committed = existsSync(SPEC_FILE) ? readFileSync(SPEC_FILE, 'utf8').replace(/\r\n/g, '\n') : '';
  if (committed !== spec) {
    console.error(`${SPEC_FILE} is out of date with the code. Run \`npm run api:spec\` and commit the result.`);
    process.exit(1);
  }
  console.log(`${SPEC_FILE} is up to date (${operations} operations).`);
} else {
  writeFileSync(SPEC_FILE, spec);
  console.log(`${SPEC_FILE} written (${operations} operations).`);
}
