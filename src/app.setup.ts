import { STATUS_CODES } from 'node:http';
import { type INestApplication, VersioningType } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { ProblemDetails } from './common/problem-details.dto.js';

/**
 * Settings that change the routes, and so the OpenAPI document. Shared by the
 * server and the spec generator so the two can never disagree.
 */
export function configureRoutes(app: INestApplication): void {
  // /v1/... for everything that is not explicitly version-neutral.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/** Stable operation ids, e.g. HealthController.live becomes healthLive. */
function operationId(controllerKey: string, methodKey: string): string {
  const controller = controllerKey.replace(/Controller$/, '');
  return controller.charAt(0).toLowerCase() + controller.slice(1) + methodKey.charAt(0).toUpperCase() + methodKey.slice(1);
}

/** The API contract. Written to openapi.json by `npm run api:spec`; the website generates its client from it. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('vrc.page API')
    .setDescription(
      'The backend for vrc.page. Errors use RFC 9457 Problem Details (application/problem+json), ' +
        'and every response carries an X-Request-Id header.',
    )
    .setVersion('1')
    .addTag('health', 'Liveness and readiness probes for load balancers and uptime checks.')
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [ProblemDetails],
    operationIdFactory: operationId,
  });

  for (const path of Object.values(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = path[method];
      if (!operation) continue;
      // The plugin leaves success descriptions empty; name them after their status.
      for (const [code, response] of Object.entries(operation.responses)) {
        if (response && 'description' in response && !response.description) response.description = STATUS_CODES[code] ?? code;
      }
      // Every operation can fail, and every failure has the same shape.
      operation.responses.default = {
        description: 'Error, as RFC 9457 Problem Details.',
        content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } } },
      };
    }
  }
  return document;
}
