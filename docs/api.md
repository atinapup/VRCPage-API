# vrc.page API

NestJS 12 on Node 22, written as ES modules in TypeScript 6. It uses Kysely over `pg` for the database (see [database.md](database.md)) and `@nestjs/swagger` for the contract.

## Running it

```
npm run dev          # watch mode, reads .env.development (PORT, WEB_ORIGIN, DB_*)
npm run build        # compile to dist/
npm start            # run dist/main.js; set NODE_ENV=production to read .env.production
npm run typecheck
```

In development, interactive docs are served at `http://localhost:4000/docs`, with the raw document at `/docs/openapi.json`. Production does not serve them.

## The contract

The API's contract is `openapi.json` at the repo root. It is generated from the code and committed. The website's typed client is generated from that file, so the two can never drift silently.

```
 NestJS controllers + DTOs
        |  npm run api:spec           (preview mode: no server, no database, no .env)
        v
 openapi.json  (committed)  ------ npm run api:spec:check fails when stale
        |  npm run api:types          (in ../VRCPage)
        v
 VRCPage/lib/api/schema.d.ts (committed)  ------ npm run api:types:check fails when stale
        |
        v
 api.GET("/v1/...") in VRCPage/lib/api/client.ts: paths, params, bodies and errors all typed
```

The database side works the same way. `npm run db:types` writes `src/database/database.types.ts` from the development database, and `npm run db:types:check` fails when it is stale.

In CI, run `api:spec:check` and `db:types:check` here and `api:types:check` in the website. `.gitattributes` pins these generated files to LF, so the checks agree on Windows too.

### Changing or adding an endpoint

1. Write the controller and its DTOs. DTO classes live in `*.dto.ts` files, where the Swagger compiler plugin reads their types and turns JSDoc comments into descriptions. A controller method's JSDoc becomes its summary.
2. `npm run api:spec`, then commit `openapi.json` with the code.
3. In `../VRCPage`: `npm run api:types`, then commit `lib/api/schema.d.ts`. The website's typecheck now shows every call that needs updating.

If the change needs a table, write the migration first, then run `npm run db:types`.

## Conventions every endpoint follows

- **Versioned routes.** Everything is under `/v1/...` (URI versioning, default version 1). Only operational endpoints, like health, are version-neutral.
- **Errors are RFC 9457 Problem Details.**
  - Every non-2xx response is `application/problem+json`: `{ type, title, status, detail?, instance?, requestId }`.
  - The spec declares it once as the `default` response of every operation, so the website's `error` is always typed.
  - Unexpected errors are logged in full and answered with a bare 500; internals never reach a client.
  - Throw Nest's `HttpException` subclasses (`NotFoundException`, `ConflictException`, ...) with a `detail` message a person can act on.
- **Every response carries `X-Request-Id`.** A valid UUID sent by the caller is kept (the website forwards its own); otherwise a new one is made. It appears in logs, in Problem Details, and later in `app.request_id` for the database's audit trail.
- **Stable operation ids.** `HealthController.live` becomes `healthLive`, so renaming a file never renames an operation.
- **Config is checked at start-up.** `AppConfig` reads every variable once and fails fast on a gap.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /health/live` | Liveness: the process is up |
| `GET /health/ready` | Readiness: the database answers and partitions exist 7 days ahead; 503 otherwise |

## Layout

```
src/
  main.ts                 server: request id, Problem Details filter, CORS, routes, dev docs
  app.setup.ts            route settings and the OpenAPI document, shared with the spec script
  app.module.ts
  config/                 AppConfig: .env.<environment> loading and validation
  database/               Database (Kysely, API login), generated database.types.ts
  common/                 Problem Details DTO and filter, request id middleware
  health/                 liveness and readiness
  scripts/generate-openapi.ts
```
