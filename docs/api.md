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

## Sign-in

Better Auth runs here, on the `DB_AUTH_USER` login (the mapping is in [database.md](database.md)). The website has none of it:

```
 browser  --->  website (vrc.page)  --->  API (/v1/auth/...)  --->  Better Auth  --->  auth schema
                       |                          |
                       |  proxies /api/auth/*  ---+   callbacks and get-session only, GET only
                       v
                  the session cookie, on the website's origin
```

- **The cookie belongs to the website.** Its server forwards the `vrcpage.*` cookies on every call and sets any `Set-Cookie` these answers carry. Nothing else it holds is sent here.
- **The website's server is the only caller** of `/v1`, so it also forwards the visitor's address as a single-value `X-Forwarded-For`, which is what Better Auth rate-limits and records sessions against. In production the API must not be reachable except through the website or a proxy that overwrites that header, or set `advanced.ipAddress.trustedProxies`.
- **The email-code endpoints of Better Auth are switched off** (`disabledPaths`), so the only way to a code is `POST /v1/auth/sign-in-code`, which checks a Cloudflare Turnstile token first. A resend uses the signed, dated pending token from that answer instead of a second check.
- **Sensitive changes** (a new address, disconnecting a provider, deleting the account) need a recent sign-in; Better Auth's refusal comes back as `session_stale`.
- **Deleting an account** deletes its `auth.accounts` row, and the database cascades the rest (database.md, "What one delete does").

## Public pages

`GET /v1/pages/{slug}` answers with a person's page or a group's, since the two share one pool of names. Private, hidden by a moderator, held after release, and never taken are one identical 404, so the route can't be used to learn whether an account exists.

A page links to another page only while that one is public: a group's `owner.slug` and a person's represented `group.slug` are null otherwise, because linking an unlisted page from somewhere public would publish its address.

## Claiming a VRChat account or a group

Proof is control of text only its owner can write, never a password (spec section 4): a person's own bio, or the description of a group they own. `POST /v1/me/vrchat/claims/{kind}` (`user` or `group`) reads the target once, so the answer can say what it is, and issues a `vrcpage-XXXXXX` code. Each press of "Check now" reads that text back. One claim of each kind is open per account, so connecting an account and adding a group never fight over the same code.

The order inside a check is deliberate, and the API owns all of it:
1. **Expiry**, then the **attempt limit**, then the **cooldown**. All three are checked before anything is read, so pressing too early never spends a read.
2. The cooldown **starts before the read**, so two quick presses can't both go out.
3. A read that fails for VRChat's own reasons **doesn't use up one of the checks**, because it said nothing about the bio.
4. On a match, the VRChat record, its page and the code being spent are **one transaction**.

Every refusal is checked twice, when the code is issued and again when it matches, and under the same problem code either way: a group handed to somebody else, made private, or claimed by another account while the code sat in its description never becomes a page. A group is refused unless VRChat says the claimer owns it, it is not private, nobody else has it, and the account is under `groups.max_per_user`.

The limits come from `config.settings` (`claim.code.*`): a six character code, fifteen minutes, eight checks, sixty seconds between them. Only one claim of a kind is open per account.

Until the rate-limited VRChat client exists, development reads the stand-in records in `src/vrchat/fake-reader.ts`, whose bios and group descriptions the `/v1/dev/vrchat/...` routes can edit. Production has nothing to read with yet and answers `unavailable` rather than pretending.

## Names

`pages.slugs` is one pool for users and groups. `GET /v1/me/names/{name}` answers `available`, `yours`, `taken`, `held`, `reserved`, `impersonation`, `invalid`, `too_short` or `too_long`; the website checks the shape as you type, and this is the check that counts. `held` is a name released in the last `slug.tombstone_days`, kept apart from `taken` here even though a screen may word them alike.

`PUT /v1/me/pages/{pageId}/name` is owners only. The first name is free; a change starts the `slug.change_cooldown_days` clock and puts the name it replaced into a hold, so nobody can pick it up to pass as its old owner. Changing only the capitals keeps the same name and costs nothing.

## Refreshing from VRChat

`POST /v1/me/pages/{pageId}/refresh` reads a page again now, rather than waiting for its turn (spec section 3). Every VRChat read is a row in `vrchat.jobs`, so a manual refresh is a job in the `manual` lane, and that table is what the limits count:
- **One manual refresh per page per `refresh.manual.cooldown_seconds`** (15 minutes), answered with `refresh_cooldown` and `retryAfter`.
- **`refresh.manual.daily_cap_per_account` a UTC day** (10), answered with `refresh_daily_limit`.
- **Owners only** while `refresh.manual.owner_only` is on.
- **Only one open job per page**, so two quick presses can't both go out.
- **A read VRChat failed counts towards neither**, the same as a claim check: it said nothing about the page.

A group is only ever published for its owner, and never while private, so a refresh that finds either has changed acts on it: a group handed to someone else is unclaimed (`group_unclaimed`; the database takes its page, links and editors, and holds the name), and one made private becomes private here too. VRChat no longer having the account or group is `vrchat_gone`.

The account's own pages (`GET /v1/me/page`, `GET /v1/me/groups/{pageId}`) carry `refreshableAt` and `nameChangeableAt`, so a screen can say when each is next allowed instead of offering a button that would refuse.

## Editors

An owner asks somebody to help run a group by their vrc.page name, because that is the only name accounts have for each other here; nobody is searched for by email, and no email is ever shown. `POST /v1/me/groups/{pageId}/editors` takes a name, finds the person's page behind it, and records an invitation. Nothing is taken on anyone's behalf: a seat exists only once they accept from their own dashboard.

- **Owners only** hand out or take back a seat, and only an owner can see who edits a page. An editor may always leave, which is the one thing they can do to a seat that isn't theirs to give.
- **Seats and waiting invitations together** are capped by `groups.editors.max_per_group`, counted again when an invitation is accepted, because the owner may have filled the group while it waited. It stays open in that case rather than being thrown away.
- **A group somebody edits never counts** toward their own `groups.max_per_user`.
- `DELETE /v1/me/groups/{pageId}/editors/{id}` takes one row off that list, whichever kind it is: an invitation taken back, an editor removed, or an editor leaving. The `id` is the opaque handle the list gives each row.

## Links

A page shows VRChat's links first, then the ones added on vrc.page. `PUT /v1/me/pages/{pageId}/links` takes the page's own links in full and in order, so adding, editing, reordering and removing are one kind of save. Owners and editors may both change them; it is the whole of an editor's job.

- **Every address is checked before anything is written** (`src/pages/links.ts`, spec section 15): parsed with the URL constructor, only plain https kept, credentials and a default port stripped, hosts in `links.custom.blocked_hosts` refused. A list with one bad link in it changes nothing, and the refusal carries `at`, the position of the link it is about.
- **The same link twice is refused**, by one identity rule: the host with or without www, the path with or without a trailing slash, and the query.
- **A row keeps its id while its address stays the same**, so a reorder or a new label is an update, and only a link that really came or went is recorded as `link_item.added` or `link_item.removed`.
- Limits come from `links.custom.*`: 8 links, 40-character labels, and a switch to turn adding off.

### Refusals a client can act on

Beyond the status code, `type` names the kind: `https://vrc.page/problems/<code>`, with one of the codes in `src/common/problem.ts` — `bot_check_failed`, `cooldown` (with `retryAfter`), `invalid_email`, `same_email`, `email_taken`, `signups_closed`, `pending_expired`, `wrong_code`, `code_expired`, `code_exhausted`, `provider_not_configured`, `not_connected`, `not_allowed`, `invalid_link`, `short_link`, `already_connected`, `vrchat_taken`, `vrchat_not_found`, `group_taken`, `not_group_owner`, `group_private`, `group_limit`, `no_such_page`, `invite_self`, `already_editor`, `already_invited`, `editor_limit`, `links_disabled`, `too_many_links`, `link_invalid`, `link_blocked`, `link_duplicate`, `label_too_long`, `refresh_cooldown` (with `retryAfter`), `refresh_daily_limit`, `vrchat_gone`, `group_unclaimed`, `name_unavailable`, `name_cooldown`, `session_stale`, `not_signed_in`, `unavailable`. Anything else is `about:blank`, where the status says it all. A refusal about one item of a submitted list also carries `at`, that item's position counting from 0.

## Email

Every message vrc.page sends goes through `MailService` (`src/mail/`) and lands in `mail.messages`, which is the record of what was sent, what was retried, and what Resend said about it afterwards.

- **Two ways in, and the difference is who is waiting.** `send()` goes out inside the request and throws if it didn't: a sign-in page must never say "code sent" while the code goes nowhere. `enqueue()` writes the message as `queued` and returns, and a drainer picks it up within fifteen seconds, so a slow Resend never slows a page down.
- **A message is written before it is sent**, with the props it was rendered from. Codes are the exception: `sign_in_code` and `email_change_code` are stored without the code, because a stored code is as good as the mailbox. They are also never retried, for the same reason.
- **Retries** are 1, 5, 25 and 125 minutes apart, and only for a rate limit or an outage; anything Resend refuses outright is `failed` at once. A second API process takes different rows (`FOR UPDATE SKIP LOCKED`), so nothing is sent twice.
- **`idempotencyKey`** names a message that must only ever exist once (`welcome:<accountId>`). The row is unique on it, and Resend gets the row's id as its own idempotency key.
- **Templates** are data, not markup (`src/mail/templates.ts`): a subject, a preheader, a heading, paragraphs, at most one button, and a note. One table layout renders all of them, with a plain-text alternative. They are sent light with a `prefers-color-scheme` dark block, which is the form that survives clients that inverts colours themselves.
- **Preferences.** A `notification` or `product` message names the switch in Settings that turns it off (`auth.notification_preferences`), and carries a `List-Unsubscribe` header and a link to those settings. Auth and account mail has no switch.
- **Without `RESEND_API_KEY`** nothing is sent: each message is printed to the API's terminal instead, and any code in it also shows at `GET /v1/dev/codes`. Production refuses to start in that state.

`POST /v1/webhooks/resend` takes Resend's delivery events. It is not in `openapi.json`, because it is Resend calling and not the website.

- The signature is checked over the raw bytes (Svix, which is the Standard Webhooks scheme), with a five-minute window, so `main.ts` asks Nest for `rawBody`. No secret, no signature, or a stale timestamp is a 401.
- Events are stored in `mail.events`, keyed on the `svix-id` header, so a webhook delivered twice does nothing twice. A message only moves forward: a late `email.sent` never undoes a `delivered`.
- The signature check has its own test: `node --experimental-strip-types src/mail/signature.ts`.
- A **permanent** bounce or a spam complaint adds the address to `mail.suppressions`. Nothing is sent to a hard-bounced address again; a complaint stops notifications but still lets a sign-in code through, or the person could never get back in. A transient bounce (a full mailbox) suppresses nothing.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /health/live` | Liveness: the process is up |
| `GET /health/ready` | Readiness: the database answers and partitions exist 7 days ahead; 503 otherwise |
| `GET /v1/auth/providers` | Which sign-in providers this server offers |
| `POST /v1/auth/sign-in-code` | Send a code, once the Turnstile token passes |
| `POST /v1/auth/sign-in-code/resend` | Send another, using the pending token |
| `POST /v1/auth/sign-in` | Check a code and sign in |
| `POST /v1/auth/social/{provider}/sign-in` | Where to send the browser for Discord or GitHub |
| `POST /v1/auth/social/{provider}/link` | The same, to attach a provider to the signed-in account |
| `DELETE /v1/auth/social/{provider}` | Disconnect a provider |
| `GET /v1/auth/session` | The signed-in account, or 401 |
| `POST /v1/auth/sign-out` | Sign out |
| `GET /v1/auth/sign-in-methods` | Providers offered, and which are attached |
| `POST /v1/auth/email-change` | Send a code to a new address |
| `POST /v1/auth/email-change/confirm` | Switch to it |
| `DELETE /v1/auth/account` | Delete the account and everything it owns |
| `GET /v1/pages/{slug}` | The public page at a name; one identical 404 for private, hidden, held and unknown |
| `GET /v1/me/dashboard` | The dashboard's frame: the account's page, groups, claims left, invites |
| `GET /v1/me/page` | The account's own page, whatever its visibility |
| `GET /v1/me/groups/{pageId}` | A group it owns or edits; any other id is a 404 |
| `GET /v1/me/notification-preferences` | Which emails it gets |
| `PUT /v1/me/pages/{pageId}/visibility` | Public, unlisted or private. Owners only; an editor gets `not_allowed` |
| `PATCH /v1/me/notification-preferences` | Change some of them; the answer is all of them |
| `DELETE /v1/me/vrchat` | Disconnect VRChat, which takes the page and its groups with it |
| `GET /v1/me/vrchat/claims/{kind}` | The claim of that kind waiting for its code, so a reload picks up where it left off |
| `POST /v1/me/vrchat/claims/{kind}` | Start one: read the account or group once, then issue the code to paste into it |
| `POST /v1/me/vrchat/claims/{kind}/check` | One press of "Check now": at most one read from VRChat |
| `DELETE /v1/me/vrchat/claims/{kind}` | Give up that claim |
| `GET /v1/me/invitations` | Invitations waiting for this account's answer |
| `POST /v1/me/invitations/{inviteId}/accept` | Accept one, taking a seat on that group's page |
| `POST /v1/me/invitations/{inviteId}/decline` | Decline one |
| `GET /v1/me/groups/{pageId}/editors` | Seats taken, then invitations waiting. Owners only |
| `POST /v1/me/groups/{pageId}/editors` | Ask the person at a vrc.page name to help run it |
| `DELETE /v1/me/groups/{pageId}/editors/{id}` | Take a row off that list: revoked, removed, or left |
| `GET /v1/me/pages/{pageId}/links` | The page's own links, in order, with the limits that apply |
| `PUT /v1/me/pages/{pageId}/links` | Replace them with this ordered list. Owners and editors |
| `POST /v1/me/pages/{pageId}/refresh` | Read it again from VRChat now. Owners only, with a wait between and a daily limit |
| `GET /v1/me/names/{name}` | Whether a name can be used, with `pageId` for the page asking |
| `PUT /v1/me/pages/{pageId}/name` | Give a page its name, or change it |
| `POST /v1/webhooks/resend` | Resend's delivery events. Signed; not in `openapi.json` |
| `GET /v1/dev/codes` | Development only: the codes printed to this terminal |
| `GET /v1/dev/vrchat/world`, `PUT /v1/dev/vrchat/...` | Development only: read and edit the stand-in VRChat, including the bios and descriptions a code is pasted into |
| `POST /v1/dev/vrchat/*`, `DELETE /v1/dev/vrchat` | Development only: connect a test VRChat user, claim its groups, invite, accept, disconnect |

**Development-only routes** are registered in `src/app.module.ts` only when the environment is development, so they do not exist in production. They are in `openapi.json` all the same, because the website's development page is typed from it.

## Layout

```
src/
  main.ts                 server: request id, Problem Details filter, CORS, routes, dev docs
  app.setup.ts            route settings and the OpenAPI document, shared with the spec script
  app.module.ts
  config/                 AppConfig: .env.<environment> loading and validation
  database/               Database (Kysely, API login), write() with the actor, generated types
  common/                 Problem Details DTO and filter, problem codes, request id and context, input checks
  audit/                  audit.events: who did what, including refusals
  auth/                   Better Auth, the /v1/auth endpoints, the session guard, Turnstile
  mail/                   templates, the outbox and its drainer, Resend, and the signed webhook
  pages/                  public pages, the signed-in account's own, and names (/v1/pages, /v1/me)
  vrchat/                 the reader seam, the stand-in records, and claim codes
  dev/                    development-only test data and shortcuts
  health/                 liveness and readiness
  scripts/generate-openapi.ts
```
