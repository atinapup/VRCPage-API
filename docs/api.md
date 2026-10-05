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

`PUT /v1/me/pages/{pageId}/name` is owners only. The first name is free; a change starts the `slug.change_cooldown_days` clock and puts the name it replaced into a hold, so nobody can pick it up to pass as its old owner. Names are lowercase: a name sent with capitals is stored without them, and sending a page's own name again changes nothing.

An admin has no cooldown, and may also take a name that is held, too short, or looks like VRChat's own. `GET /v1/me/names/{name}` answers an admin by the same rules, so the field and the save agree. Reserved names stay refused for everyone: they are the website's own routes.

An **alias** is another name for a page. `GET /v1/pages/{slug}` answers one with `alias: true`, and with `redirect` saying what to do with it: true sends the visitor on to `slug` (308), false shows the page at the alias, with the address left as it is. The page's canonical address is its own name either way. Only admins add, change or remove aliases (`/v1/admin/pages/{pageId}/aliases`), and a removed alias is held like any released name. The website answers a redirect alias in place, without the 308, when the visitor is a link-preview bot, so a shared alias still unfurls.

`GET /v1/showcase` is the example on the website's home page: one of the user pages an admin picked (`/v1/admin/pages/{pageId}/showcase`), at random when there are several, or a 404 when none is. Only public, visible pages are answered, since the home page would otherwise publish an unlisted page's address.

## Refreshing from VRChat

`POST /v1/me/pages/{pageId}/refresh` reads a page again now, rather than waiting for its turn (spec section 3). Every VRChat read is a row in `vrchat.jobs`, so a manual refresh is a job in the `manual` lane, and that table is what the limits count:
- **One manual refresh per page per `refresh.manual.cooldown_seconds`** (15 minutes), answered with `refresh_cooldown` and `retryAfter`.
- **`refresh.manual.daily_cap_per_account` a UTC day** (10), answered with `refresh_daily_limit`.
- **Owners only** while `refresh.manual.owner_only` is on.
- **Only one open job per page**, so two quick presses can't both go out. A refresh that fails after taking its job still closes it, and a job left `running` for five minutes is closed as `abandoned` by the next press, so a crash or restart can never lock a page out of refreshes.
- **A read VRChat failed counts towards neither**, the same as a claim check: it said nothing about the page.
- **An admin skips the page's wait, the daily cap and the owner-only rule**, on any page. VRChat's own turn, once a minute for the whole site, still applies to them: it protects the account every read is made with.

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
- **A link can be marked 18+** with `adult: true`. `PageLink.adult` carries it to the website, which also treats every OnlyFans and Fansly link as 18+ and asks visitors to confirm before opening one.
- **The same link twice is refused**, by one identity rule: the host with or without www, the path with or without a trailing slash, and the query.
- **A row keeps its id while its address stays the same**, so a reorder or a new label is an update, and only a link that really came or went is recorded as `link_item.added` or `link_item.removed`.
- **A link can be hidden**: the page's own with `hidden: true` in the save, VRChat's with `PUT /v1/me/pages/{pageId}/hidden-links` (`{url, hidden}`), remembered by link identity in `pages.hidden_links` since those have no row of their own. `PageLink.hidden` marks them for the owner's lists; `GET /v1/pages/{slug}` leaves them out, so a hidden link never reaches a visitor.
- **The Socials page can be turned off** with `PUT /v1/me/pages/{pageId}/socials` (`{enabled}`). Pages carry `socialsEnabled`; off, the website sends its links address to the profile.
- Limits come from `links.custom.*`: 40-character labels, a switch to turn adding off, and a ceiling of 100 links a page that is there against abuse rather than as a limit to show.

## Page stats

The website reports what visitors do on a public page with `POST /v1/pages/{pageId}/events`, one call per event, each carrying the `visitId` the browser made for that load of the page:
- **`view`** when the page opens. It goes in `pages.views` with `visitor_hash` (`src/common/visitor.ts`: an HMAC of the address, as `addressKey()` gives it, under a key derived from `BETTER_AUTH_SECRET` and the UTC month), the visitor's country as Cloudflare named it, and the referring site's host. Never the address itself.
- **`click`** when one of its links is opened. The address must be one of the page's visible links by link identity, and the page's own copy of it is what is stored, so nobody can write other links into a page's stats.
- **`leave`** when the visitor moves on, with the seconds the page was visible, capped at 30 minutes.

**It always answers 204.** A page that is private, taken down or missing, or a link the page doesn't have, is dropped without saying so, so the route can't be asked what exists. It has its own rate limit, `beacon`, 120 a minute per address. The website only calls it for visitors who don't run the page, and never for bots.

Reading them back:
- **`GET /v1/me/pages/{pageId}/stats?days=7|30|90`** is for anyone who runs the page: owners, editors, and admins. It has views and unique visitors by UTC day, link clicks, how many visits opened a link, the median and average stay and a breakdown of stays, and every link on the page with its clicks (zeros included, then removed links that were opened).
- **`GET /v1/admin/stats?days=&pageId=`** is for admins only. It has the same numbers, plus the visitors' countries, referring sites, views by hour of day, and the last 50 visits. Without `pageId` it covers the whole site: account and page counts, the most viewed pages, and the sites links led to. Where and when visitors came are on this route only.

Every range ends today (UTC) and reads the raw logs, which are kept 90 days. Unique visitors are counted per calendar month, because the hash key changes monthly, so a range crossing a month can count one visitor twice.

## Admin

An account with the `admin` role in `auth.account_roles` may run every page and every account. There are two halves to that:

- **Everything an owner can change on a page, an admin changes through the owner's own endpoints.** `PagesService.role()` answers `admin` for them on every page, their own included, and every owner-only check refuses only an `editor`. So a page's name, visibility, links, refresh and editors are one set of endpoints and rules, with no second copy to drift. An admin's own pages carry `nameChangeableAt` and `refreshableAt` as null.
- **What only staff can do is under `/v1/admin`**, behind `SessionGuard` and then `AdminGuard`. Anyone signed in who isn't an admin gets a plain 404, the same as a route that doesn't exist. Every write there runs as a `staff` actor, so row history and `audit.events` (actions named `admin.*`, kept as security events) both say which admin did it.

What's there:
- **Accounts:** list and search them, change an email address or name, grant and revoke roles, end every session, disconnect VRChat, and delete an account.
- **Pages:** list and search them, take one down and put it back, and add, change or remove aliases.

Some changes need rules of their own:
- **Email and name** go through Better Auth's `internalAdapter`, because the auth login owns `auth.accounts`. A new address sends the old one the same `email_changed` mail an owner's own change does.
- **Nobody can take away their own admin role**, or delete their own account from here (that is Settings), so an admin can't lock themselves out.
- **A page taken down** answers exactly like a missing one, and its owner can't undo it.

**The first admin** has nobody to grant it, so it comes from the database: `npm run db:grant-admin -- <email>` (or `db:grant-admin:prod`). Its account must have signed in once. Every admin after that is granted from the website.

### Refusals a client can act on

Beyond the status code, `type` names the kind: `https://vrc.page/problems/<code>`, with one of the codes in `src/common/problem.ts` — `bot_check_failed`, `cooldown` (with `retryAfter`), `invalid_email`, `same_email`, `email_taken`, `signups_closed`, `pending_expired`, `wrong_code`, `code_expired`, `code_exhausted`, `provider_not_configured`, `not_connected`, `not_allowed`, `invalid_link`, `short_link`, `already_connected`, `vrchat_taken`, `vrchat_not_found`, `group_taken`, `not_group_owner`, `group_private`, `group_limit`, `no_such_page`, `invite_self`, `already_editor`, `already_invited`, `editor_limit`, `links_disabled`, `too_many_links`, `link_invalid`, `link_blocked`, `link_duplicate`, `label_too_long`, `not_a_picture`, `too_large`, `refresh_cooldown` (with `retryAfter`), `refresh_daily_limit`, `vrchat_gone`, `group_unclaimed`, `name_unavailable`, `name_cooldown`, `session_stale`, `not_signed_in`, `unavailable`. Anything else is `about:blank`, where the status says it all. A refusal about one item of a submitted list also carries `at`, that item's position counting from 0.

## Reading VRChat

VRChat has no public API, asks that nobody query it more than once a minute, and can terminate an account it thinks is abusing it. One flagged service account stops the whole product, so `src/vrchat/client.ts` is built to be careful before it is built to be quick. It is the only code in the API that makes an outbound call to VRChat, and nothing in the browser ever does.

**Taking a turn.** Every read locks the single `vrchat.client_state` row, checks five things, and pushes `next_call_at` forward *before* the call goes out. Only one turn exists per `vrchat.api.min_interval_seconds`, so two reads can never be in flight, across every request and every API process. The five:

1. `vrchat.api.enabled`, the kill switch. Changing it takes effect on the next read, with no restart.
2. The circuit breaker: `circuit_opened_at`, set after `vrchat.api.circuit_breaker_threshold` refusals in a row.
3. The rate-limit backoff: `backoff_until`, set by a 429.
4. The minimum spacing: `next_call_at`.
5. The lane's share of the day, from `vrchat.budget_today`. A lane that has spent its share waits until midnight UTC; it never borrows from another.

**Nothing waits.** A read that cannot have the turn returns `busy` with the number of seconds until one is free. Holding a request open for a minute would only move the queue into somebody's browser, so the wait is given to the client to show.

**A manual refresh queues instead.** When a refresh press finds the turn taken, its job in `vrchat.jobs` goes back to `queued` with `run_after` set to when the turn frees, and the answer is `refreshedAt: null`. `RefreshService` checks the queue every ten seconds and runs the oldest job that is due, one per pass, taken with `FOR UPDATE SKIP LOCKED` so two processes never run the same one. A job that finds the turn taken again goes back in the queue. A wait of more than five minutes is a spent lane, a backoff or the kill switch rather than a busy turn: that press is refused with `refresh_cooldown`, and nothing is queued. To try it without an account, `PUT /v1/dev/vrchat/reads` with `{"reads": "busy"}` makes every test read answer as if the turn were taken.

**A 429 stops every lane**, not just the one that caused it, because the limit is on the account. The wait doubles from `backoff_initial_seconds` to `backoff_max_seconds` with a fifth either way of jitter, and VRChat's own `Retry-After` wins when it asks for longer. `src/vrchat/budget.ts` holds that sum and its test: `node --experimental-strip-types src/vrchat/budget.ts`.

**A refused session signs in again, once.** A 401 drops the stored session, and the next read signs in before it reads. Three refusals in a row, of the session or of the sign-in, open the circuit and log what to do. That's a changed password, a wrong TOTP secret or a locked account, and signing in again every minute is how an account gets locked for good. Pages keep serving from the database; only claims and refreshes stop. A restart closes the circuit, because a restart is how a fixed account arrives.

**Every read is logged** to `vrchat.api_calls` with its lane, endpoint, status, outcome, duration and job, and that table is also what the daily budget counts. Sign-ins spend no budget and go to the API's log instead.

### Which endpoints, and why

| Read | Endpoint |
|---|---|
| A person | `GET /profile/{userId}` |
| A person's status, on refresh | `GET /users/{userId}` |
| A group | `GET /groups/{groupId}` |

`GET /profile/{userId}`, not `GET /users/{userId}`: VRChat moved the bio onto the profile, and the bio is where a `vrcpage-` code is pasted. The profile also carries the represented group and the languages as plain arrays. Since VRChat's API 1.21 it only tells a profile's owner their `status` and `statusDescription`, so a refresh of a person makes a second read, of `GET /users/{userId}`, for those and `trustRank`. It goes from the same lane once the slot frees, about a minute after the first, and nobody waits for it (`readStatus` in `src/pages/refresh.service.ts`). A claim stays one read, so a new page shows its status from its first refresh; until then it reads as offline with no status line.

18+ comes from `ageVerificationStatus`, not from `ageVerified`: someone who verified and set it to hidden is not shown as 18+ here either.

`src/vrchat/api.ts` maps both answers and is where VRChat's shape is pinned down. Every field is treated as missing until proved otherwise, and anything too long for its column is cut rather than refused, so one changed field never throws away a whole snapshot. Its test is `node --experimental-strip-types src/vrchat/api.ts`. A group missing `ownerId` or `privacy` is unreadable rather than guessed at, because guessing `default` would publish a group somebody made private.

### What spends a call

Nothing reads VRChat on a page view, ever. Reads come from three places only:

- **Issuing a group's claim code** and **one press of "Check now"**, from the verification lane. Both cost a read, so both wait `claim.code.check_cooldown_seconds` after the account's last one; without that, giving up a claim and starting another in a loop would spend the whole lane for everybody. A person's code is issued without a read: nothing VRChat says can refuse it that the database can't, and reading twice in a row would put their first check a minute behind the read that issued it. Their name arrives when the code matches. A check that finds VRChat's turn taken (`busy`) asked nothing, so it hands its cooldown back and the claim's `checkIn` says when the turn frees. Asking again for the claim already open reads nothing and hands back the same code, and neither does reopening a group's: its name is kept on `vrchat.claim_codes.display_name` from the read that issued it.
- **A manual refresh**, from the manual lane, behind a per-page cooldown and a per-account daily cap. A person's costs two reads: the profile, then their status. A press that finds the turn taken waits in the queue (above) and still counts towards both limits.

**The session.** The API signs in as a spare account made for vrc.page: `VRCHAT_USERNAME`, `VRCHAT_PASSWORD` and `VRCHAT_TOTP_SECRET`. That's the one VRChat password vrc.page holds, and it belongs to nobody but vrc.page. Signing in is `GET /auth/user` with Basic auth, then `POST /auth/twofactorauth/totp/verify` with the code `src/vrchat/totp.ts` works out from the secret (its test: `node --experimental-strip-types src/vrchat/totp.ts`). The account needs authenticator-app 2FA, because an email code can't be answered without a person.

The cookie that comes back is kept in `vrchat.client_state.auth_cookie`, which the readonly role can't see. VRChat limits how many sessions an account opens, so a restart or a second process reuses it, and only a refusal replaces it. A cookie pasted from a browser is not used, because VRChat can drop a session when the address using it changes; the server signs in from its own. Without an account, development reads the test records in `src/vrchat/fake-reader.ts` and anything else says it cannot read.

## Pictures

VRChat icons and banners are copied, never linked: a public page must not make a request to a VRChat domain, and VRChat's addresses aren't stable. The copies live in Postgres, in `vrchat.images`, so there is no bucket to run, back up or clean separately. `src/vrchat/images.ts` does the work:

- **When.** A claim that matches, and every refresh. Each picture is fetched and re-encoded *before* the snapshot's transaction opens, because a download can take seconds. It is saved inside the transaction, so the picture and the page change together.
- **Only what's new.** `source_url` remembers the address VRChat gave. A refresh that sees the same address reuses the row and downloads nothing, so pictures cost a download per upload, not per read. They take no slot and spend no budget, but the kill switch, the circuit and a backoff still stop them. Only `*.vrchat.cloud` and `*.vrchat.com` are fetched, since the server sits on a private network, and nothing over 16 MB.
- **Stored as** WebP, fitted inside 512px (icons) or 1600px (banners), named by the sha256 of those bytes. Two people with the same picture share one row.
- **Kept when a download fails.** The old picture beats none; a picture VRChat no longer has is removed.
- **Deleted by the database.** A trigger (`internal.drop_unused_images`, migration `20260929130000`) deletes a picture the moment no user or group uses it, which covers a changed picture, a disconnect, an unclaimed group and a deleted account, whose cascade arrives there too. Users and groups hold their pictures with `ON DELETE RESTRICT`, so nothing can delete one still on a page.
- **Uploaded pictures and banners** (`PUT /v1/me/pages/{pageId}/picture` and `/banner`, the picture's own bytes as the body, PNG, JPEG, WebP or GIF up to 8 MB) go through the same encoding, except that a picture is cut to a 512px square from its middle. They are stored with no `source_url` and hang off `pages.pages.picture_image_id` and `banner_image_id`. A page's own wins over VRChat's (`avatarUrl` or `iconUrl`, and `bannerUrl`; `ownPictureUrl` and `ownBannerUrl` are the uploaded ones), and `DELETE` goes back to VRChat's. The clean-up trigger checks pages' own pictures too (migrations `20261002090300`, `20261003090000`).
- **Served** by `GET /v1/images/{sha256 hex}.webp` with a thirty-day `Cache-Control`, and the website serves that at `/images/<file>`. Pages get the relative address, which `next/image` optimizes like any local picture. Thirty days is the spec's limit for a deleted account's pictures leaving every cache. The route is not rate limited: it is one indexed read, and most requests come from the website's optimizer, all from one address.

## Appearance and accessibility

- **A page's accent colour** is `PUT /v1/me/pages/{pageId}/accent` (`{accent: "#rrggbb" | null}`), owners and editors. Pages carry `accent`; the website works the page's whole palette out from it.
- **How the site looks for one account** is `GET` / `PATCH /v1/me/preferences`: `highContrast`, `dyslexiaFont` and `lightMode` (light mode on the website), kept in `auth.account_preferences`. The website mirrors them into a cookie of its own so they apply before a page is drawn.

## What's new

Short notes about changes to vrc.page, in the `news` schema. Admins write them through `/v1/admin/updates` (create as a draft, change, publish or unpublish with `published`, delete) and attach one picture or clip with `PUT /v1/admin/updates/{id}/media`, the file's own bytes as the body:

- **Pictures** (PNG, JPEG, WebP, GIF) are re-encoded to WebP with sharp, fitted inside 1600px, keeping a GIF's animation. **Clips** (MP4, WebM) are stored as sent. Either is checked by its first bytes, never its claimed type, and is at most 25 MB (`main.ts` reads only these types as raw bytes, and no more than that).
- **Served** by `GET /v1/updates/media/{sha256 hex}.{webp|mp4|webm}`, immutable, which the website serves at `/updates/media/<file>` with byte ranges for Safari. A picture or clip no update uses any more is deleted with it.
- **The body is Markdown**, up to 2000 characters: emphasis, links, lists, headings and code. The website draws it without raw HTML or images; the picture or clip goes in the media slot.
- **Each account sees an update once.** `GET /v1/me/updates` answers the latest ten published and `seenAt`; the website shows the ones published after it, and `POST /v1/me/updates/seen` moves it on. An account that has never looked starts at its own creation, so new accounts aren't greeted with old news.

## Two database logins, and why readiness checks both

The API signs in to Postgres twice: `DB_API_*` for everything the site renders, and `DB_AUTH_*` for Better Auth, on its own pool. Only the second can sign anybody in.

That means a wrong `DB_AUTH_PASSWORD` is invisible from the outside. Every page renders, `/v1/pages/{slug}` answers, the sign-in page even lists its providers — and then every sign-in fails with `password authentication failed`, and nothing is written, not even an audit row, because the request dies in the session guard before anything is recorded.

`GET /health/ready` therefore queries both. It used to check only the api login and report `ok`, which is exactly how a deployment served perfectly while nobody could log in.

**A `$` in a password is the likely cause.** Docker Compose and the tools built on it interpolate `$` in environment values, so a password containing one arrives at the container mangled. Either escape it as `$$` wherever the deployment sets it, or use a password without `$`.

## What production refuses to start without

`AppConfig` checks these at start-up rather than letting the first visitor find them. Each one is the difference between a working site and one that looks fine until somebody tries to sign in:

| Variable | Why it is fatal |
|---|---|
| `WEB_ORIGIN`, `DB_HOST`, `DB_NAME`, `DB_API_*`, `DB_AUTH_*` | Nothing runs without them |
| `BETTER_AUTH_SECRET` | Sessions, OAuth state and pending sign-in tokens are signed with it |
| `RESEND_API_KEY` | No email means no sign-in codes. `VRCPAGE_PRINT_SIGN_IN_CODES=true` is the escape hatch for a local production build |
| `TURNSTILE_SECRET_KEY` | The bot check fails closed, so every code would be refused |

A missing VRChat account is a warning, not a failure: pages still serve from the database, they just stop being refreshed.

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

**The address to register in Resend is the website's**, `https://vrc.page/api/webhooks/resend`, which forwards the bytes here. The API is not on the internet and should not be: it trusts the `X-Forwarded-For` the website sets, so anything able to reach it directly could claim any address and walk past Better Auth's rate limits and the IP on every security audit row. This webhook is the only thing inbound that is not a browser, so it comes the same way as everything else. Discord and GitHub need nothing: their callbacks redirect the browser to the website, which proxies the GET here.

- The signature is checked over the raw bytes (Svix, which is the Standard Webhooks scheme), with a five-minute window, so `main.ts` asks Nest for `rawBody`. No secret, no signature, or a stale timestamp is a 401.
- **Subscribe to seven events**, which are the ones that change anything: `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed` and `email.suppressed`. Not `email.opened` or `email.clicked`: both need Resend's tracking turned on, which puts a pixel in every message and rewrites every link, and vrc.page sends sign-in codes rather than marketing. The contact, domain and suppression events are about Resend's own records, not ours.
- Events are stored in `mail.events`, keyed on the `svix-id` header, so a webhook delivered twice does nothing twice. A message only moves forward, by the rank in `mail.controller.ts`: a late `email.sent` never undoes a `delivered`, and never undoes a `failed` either. Bad news outranks good, because it is final.
- The signature check has its own test: `node --experimental-strip-types src/mail/signature.ts`.
- A **permanent** bounce or a spam complaint adds the address to `mail.suppressions`. Nothing is sent to a hard-bounced address again; a complaint stops notifications but still lets a sign-in code through, or the person could never get back in. A transient bounce (a full mailbox) suppresses nothing.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /health/live` | Liveness: the process is up |
| `GET /health/ready` | Readiness: **both** database logins answer and partitions exist 7 days ahead; 503 otherwise |
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
| `GET /v1/showcase` | One of the pages picked for the home page, at random; 404 when none is |
| `POST /v1/pages/{pageId}/events` | A visitor opened the page, opened one of its links, or left. Always 204 |
| `GET /v1/me/dashboard` | The dashboard's frame: the account's page, groups, claims left, invites |
| `GET /v1/me/page` | The account's own page, whatever its visibility |
| `GET /v1/me/groups/{pageId}` | A group it owns or edits; any other id is a 404 |
| `GET /v1/me/notification-preferences` | Which emails it gets |
| `GET`, `PATCH /v1/me/preferences` | Higher contrast, the dyslexia font and light colours, for this account |
| `GET /v1/me/updates` | The latest "What's new" updates, and how far this account has read |
| `POST /v1/me/updates/seen` | Everything published so far has been seen |
| `GET /v1/updates/media/{file}` | A picture or clip from an update |
| `PUT /v1/me/pages/{pageId}/socials` | Turn the page's Socials page on or off. Owners and editors |
| `PUT /v1/me/pages/{pageId}/hidden-links` | Show or hide one of VRChat's links on the page. Owners and editors |
| `PUT /v1/me/pages/{pageId}/accent` | The page's accent colour, or null. Owners and editors |
| `PUT`, `DELETE /v1/me/pages/{pageId}/picture` | A picture of the page's own, shown instead of VRChat's. Owners and editors |
| `PUT`, `DELETE /v1/me/pages/{pageId}/banner` | A banner of the page's own, shown instead of VRChat's. Owners and editors |
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
| `GET /v1/me/pages/{pageId}/stats` | Views, visitors, time on page and link clicks over 7, 30 or 90 days. Owners and editors |
| `GET /v1/me/pages/{pageId}/links` | The page's own links, in order, with the limits that apply |
| `PUT /v1/me/pages/{pageId}/links` | Replace them with this ordered list. Owners and editors |
| `POST /v1/me/pages/{pageId}/refresh` | Read it again from VRChat now. Owners only, with a wait between and a daily limit; admins skip both |
| `GET /v1/me/names/{name}` | Whether a name can be used, with `pageId` for the page asking |
| `PUT /v1/me/pages/{pageId}/name` | Give a page its name, or change it |
| `GET /v1/admin/accounts` | Admins: accounts, newest first, 50 at a time (`q` searches, `before` pages) |
| `GET /v1/admin/accounts/{accountId}` | Admins: one account's details, roles, sign-ins, sessions, VRChat user and pages |
| `PATCH /v1/admin/accounts/{accountId}` | Admins: change its email address or name |
| `PUT`, `DELETE /v1/admin/accounts/{accountId}/roles/{role}` | Admins: grant or revoke `admin`, `moderator` or `partner` |
| `DELETE /v1/admin/accounts/{accountId}/sessions` | Admins: sign it out everywhere |
| `DELETE /v1/admin/accounts/{accountId}/vrchat` | Admins: disconnect its VRChat account |
| `DELETE /v1/admin/accounts/{accountId}` | Admins: delete it and everything it owns |
| `GET /v1/admin/stats` | Admins: every page stat, plus countries, referrers, hours and recent visits; the whole site, or one page with `pageId` |
| `GET /v1/admin/pages` | Admins: every page, whatever its visibility, 50 at a time |
| `GET /v1/admin/pages/{pageId}` | Admins: one page with its owner, aliases, takedown and whether it is a home page example |
| `PUT`, `DELETE /v1/admin/pages/{pageId}/hidden` | Admins: take it down with a reason, or put it back |
| `PUT`, `DELETE /v1/admin/pages/{pageId}/showcase` | Admins: pick a person's page as a home page example, or drop it |
| `GET`, `POST /v1/admin/updates` | Admins: every "What's new" update, or a new draft |
| `GET`, `PATCH`, `DELETE /v1/admin/updates/{id}` | Admins: one update; change, publish or unpublish it, or delete it |
| `PUT`, `DELETE /v1/admin/updates/{id}/media` | Admins: its picture or clip |
| `POST /v1/admin/pages/{pageId}/aliases` | Admins: give it another name, which redirects or shows the page |
| `PATCH`, `DELETE /v1/admin/pages/{pageId}/aliases/{name}` | Admins: flip an alias's redirect, or remove it |
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
  admin/                  staff tools for any account and page (/v1/admin), behind AdminGuard
  vrchat/                 the reader seam, the stand-in records, and claim codes
  dev/                    development-only test data and shortcuts
  health/                 liveness and readiness
  scripts/generate-openapi.ts
```
