-- Invariant checks for the vrc.page schema (plan section 9).
--
-- Run with `npm run db:test`. It connects as a server admin, switches between
-- the application roles with SET SESSION AUTHORIZATION, and ROLLS BACK at the
-- end, so it leaves nothing behind. The first failure stops the run with its
-- message.
--
-- Fixed ids used below:
--   accounts  A owner ...0a   E editor ...0e   M moderator ...0d   I invitee ...0c   X spare ...0f
--   pages     PA (A's user page) ...a1   PG (A's group page) ...a2   PE (E's page) ...e1   PI (I's page) ...c1
--   links     L1 ...e2   L2 ...e3   (both on PE)
--   VRChat    usr_aaaa… = A   usr_eeee… = E   usr_cccc… = I   grp_1111… = A's group
--             usr_bbbb… banned   usr_dddd… banned then lifted   usr_9999… ban already expired

BEGIN;

-- Runs a statement and fails the whole check unless the database refuses it.
CREATE FUNCTION internal.test_rejects(statement text, label text) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok    refused: % (%)', label, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL  % was allowed: %', label, statement;
END
$$;
GRANT EXECUTE ON FUNCTION internal.test_rejects(text, text) TO PUBLIC;

-------------------------------------------------------------------------------
-- Fixtures
-------------------------------------------------------------------------------

SELECT set_config('app.request_id', '00000000-0000-7000-8000-000000000f00', true),
       set_config('app.actor_type', 'system', true);

INSERT INTO auth.accounts (id, email, name) VALUES
  ('00000000-0000-7000-8000-00000000000a', 'owner@test.invalid', 'Owner'),
  ('00000000-0000-7000-8000-00000000000e', 'editor@test.invalid', 'Editor'),
  ('00000000-0000-7000-8000-00000000000d', 'moderator@test.invalid', 'Moderator'),
  ('00000000-0000-7000-8000-00000000000c', 'invitee@test.invalid', ''),
  ('00000000-0000-7000-8000-00000000000f', 'spare@test.invalid', '');

INSERT INTO auth.account_roles (account_id, role, granted_by) VALUES
  ('00000000-0000-7000-8000-00000000000d', 'moderator', '00000000-0000-7000-8000-00000000000a');

INSERT INTO vrchat.users (id, account_id, display_name, fetched_at) VALUES
  ('usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-7000-8000-00000000000a', 'Atian', now()),
  ('usr_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '00000000-0000-7000-8000-00000000000e', 'Editor', now()),
  ('usr_cccccccc-cccc-4ccc-8ccc-cccccccccccc', '00000000-0000-7000-8000-00000000000c', 'Invitee', now());

INSERT INTO vrchat.claim_codes (account_id, target_kind, vrchat_group_id, code, status, expires_at, resolved_at) VALUES
  ('00000000-0000-7000-8000-00000000000a', 'group', 'grp_11111111-1111-4111-8111-111111111111',
   'vrcpage-ABCDEF', 'succeeded', now() + interval '15 minutes', now());

INSERT INTO vrchat.groups (id, claimed_by_vrchat_user_id, name, short_code, discriminator, privacy,
                           owner_vrchat_user_id, fetched_at) VALUES
  ('grp_11111111-1111-4111-8111-111111111111', 'usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'Night Market', 'NIGHT', '1234', 'default', 'usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now());

INSERT INTO pages.pages (id, kind, vrchat_user_id, vrchat_group_id) VALUES
  ('00000000-0000-7000-8000-0000000000a1', 'user',  'usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL),
  ('00000000-0000-7000-8000-0000000000a2', 'group', NULL, 'grp_11111111-1111-4111-8111-111111111111'),
  ('00000000-0000-7000-8000-0000000000e1', 'user',  'usr_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', NULL),
  ('00000000-0000-7000-8000-0000000000c1', 'user',  'usr_cccccccc-cccc-4ccc-8ccc-cccccccccccc', NULL);

INSERT INTO pages.slugs (slug_key, slug, page_id, role) VALUES
  ('atian',       'Atian',       '00000000-0000-7000-8000-0000000000a1', 'primary'),
  ('atianpup',    'atianpup',    '00000000-0000-7000-8000-0000000000a1', 'alias'),
  ('nightmarket', 'NightMarket', '00000000-0000-7000-8000-0000000000a2', 'primary'),
  ('editor1',     'editor1',     '00000000-0000-7000-8000-0000000000e1', 'primary'),
  ('invitee',     'invitee',     '00000000-0000-7000-8000-0000000000c1', 'primary');

INSERT INTO pages.links (id, page_id, position, url, label) VALUES
  ('00000000-0000-7000-8000-0000000000e2', '00000000-0000-7000-8000-0000000000e1', 0, 'https://twitch.tv/editor', 'Twitch'),
  ('00000000-0000-7000-8000-0000000000e3', '00000000-0000-7000-8000-0000000000e1', 1, 'https://booth.pm/editor', NULL);

INSERT INTO pages.editor_invites (page_id, invited_account_id, invited_by_account_id, status, responded_at) VALUES
  ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-00000000000e',
   '00000000-0000-7000-8000-00000000000a', 'accepted', now()),
  ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-00000000000c',
   '00000000-0000-7000-8000-00000000000a', 'pending', NULL);
INSERT INTO pages.editors (page_id, account_id) VALUES
  ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-00000000000e');

INSERT INTO config.legal_documents (id, kind, version, published_at, url, content_sha256) VALUES
  ('00000000-0000-7000-8000-000000000d01', 'terms', 'test-1', now(), 'https://vrc.page/terms', sha256('terms'));
INSERT INTO config.legal_acceptances (account_id, document_id) VALUES
  ('00000000-0000-7000-8000-00000000000a', '00000000-0000-7000-8000-000000000d01');

INSERT INTO audit.events (actor_type, actor_account_id, action) VALUES
  ('account', '00000000-0000-7000-8000-00000000000a', 'test.fixture');

-- The moderator hides E's page and bans then lifts usr_dddd….
UPDATE pages.pages
   SET hidden_at = now(), hidden_reason = 'test takedown', hidden_by = '00000000-0000-7000-8000-00000000000d'
 WHERE id = '00000000-0000-7000-8000-0000000000e1';
INSERT INTO moderation.bans (subject_type, vrchat_user_id, reason, public_reason, created_by,
                             lifted_at, lift_reason, lifted_by) VALUES
  ('vrchat_user', 'usr_dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'test', 'Test ban.',
   '00000000-0000-7000-8000-00000000000d', now(), 'test lift', '00000000-0000-7000-8000-00000000000d');

-------------------------------------------------------------------------------
-- 1. Better Auth can create an account and the database picks the id.
-------------------------------------------------------------------------------

SET SESSION AUTHORIZATION vrcpage_auth;
INSERT INTO auth.accounts (email, name) VALUES ('fresh@test.invalid', '');
RESET SESSION AUTHORIZATION;

DO $$
BEGIN
  ASSERT (SELECT id FROM auth.accounts WHERE email = 'fresh@test.invalid') IS NOT NULL, 'account id generated';
  RAISE NOTICE 'ok    Better Auth insert gets a database id';
END
$$;

-------------------------------------------------------------------------------
-- 2. Deleting an account (the way Better Auth does it) removes everything it owns
--    and holds its names, without touching logs.
-------------------------------------------------------------------------------

SET SESSION AUTHORIZATION vrcpage_auth;
DELETE FROM auth.accounts WHERE id = '00000000-0000-7000-8000-00000000000a';
RESET SESSION AUTHORIZATION;

DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM vrchat.users WHERE id = 'usr_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'VRChat user removed';
  ASSERT NOT EXISTS (SELECT 1 FROM vrchat.groups WHERE id = 'grp_11111111-1111-4111-8111-111111111111'), 'group removed';
  ASSERT NOT EXISTS (SELECT 1 FROM vrchat.claim_codes WHERE account_id = '00000000-0000-7000-8000-00000000000a'), 'claim codes removed';
  ASSERT NOT EXISTS (SELECT 1 FROM pages.pages
                      WHERE id IN ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-0000000000a2')), 'pages removed';
  ASSERT NOT EXISTS (SELECT 1 FROM pages.editors WHERE page_id = '00000000-0000-7000-8000-0000000000a2'), 'editor seat removed';
  ASSERT NOT EXISTS (SELECT 1 FROM pages.editor_invites WHERE page_id = '00000000-0000-7000-8000-0000000000a2'), 'invites removed';
  ASSERT NOT EXISTS (SELECT 1 FROM config.legal_acceptances
                      WHERE account_id = '00000000-0000-7000-8000-00000000000a'), 'acceptance removed';
  ASSERT (SELECT granted_by FROM auth.account_roles
           WHERE account_id = '00000000-0000-7000-8000-00000000000d') IS NULL, 'role grant keeps, granter nulled';
  ASSERT (SELECT count(*) FROM pages.slugs
           WHERE slug_key IN ('atian', 'atianpup', 'nightmarket')
             AND page_id IS NULL
             AND blocked_until > now() + interval '89 days') = 3, 'all three names held for 90 days';
  ASSERT EXISTS (SELECT 1 FROM audit.events WHERE action = 'test.fixture'), 'audit event untouched';
  ASSERT EXISTS (SELECT 1 FROM audit.row_changes
                  WHERE schema_name = 'auth' AND table_name = 'accounts' AND operation = 'delete'
                    AND row_key = '{"id": "00000000-0000-7000-8000-00000000000a"}'
                    AND db_role = 'vrcpage_auth'), 'deletion recorded with the real login';
  RAISE NOTICE 'ok    account deletion cascades, holds names, keeps logs';
END
$$;

-------------------------------------------------------------------------------
-- 3. Deleting a staff account keeps what they did, minus their id.
-------------------------------------------------------------------------------

DELETE FROM auth.accounts WHERE id = '00000000-0000-7000-8000-00000000000d';

DO $$
BEGIN
  ASSERT (SELECT hidden_at IS NOT NULL AND hidden_by IS NULL FROM pages.pages
           WHERE id = '00000000-0000-7000-8000-0000000000e1'), 'takedown stays, hidden_by nulled';
  ASSERT (SELECT lifted_at IS NOT NULL AND lifted_by IS NULL AND created_by IS NULL FROM moderation.bans
           WHERE vrchat_user_id = 'usr_dddddddd-dddd-4ddd-8ddd-dddddddddddd'), 'ban stays, staff ids nulled';
  RAISE NOTICE 'ok    staff deletion keeps bans and takedowns';
END
$$;

-------------------------------------------------------------------------------
-- 4. Logs are locked, even for the owner; the API cannot get around the locks.
-------------------------------------------------------------------------------

SET SESSION AUTHORIZATION vrcpage_owner;
SELECT internal.test_rejects($$UPDATE audit.events SET action = 'test.changed' WHERE action = 'test.fixture'$$, 'owner updates an audit event');
SELECT internal.test_rejects($$DELETE FROM audit.events WHERE action = 'test.fixture'$$, 'owner deletes an audit event');
SELECT internal.test_rejects($$TRUNCATE audit.events$$, 'owner truncates audit.events');
SELECT internal.test_rejects($$DELETE FROM audit.row_changes$$, 'owner deletes history');
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION vrcpage_api;
SELECT internal.test_rejects($$INSERT INTO audit.row_changes (tx_id, db_role, schema_name, table_name, operation, row_key, new_values)
                               VALUES (1, 'x', 'x', 'x', 'insert', '{}', '{}')$$, 'API forges history');
SELECT internal.test_rejects($$DELETE FROM moderation.bans$$, 'API deletes a ban');
SELECT internal.test_rejects($$DELETE FROM moderation.reports$$, 'API deletes a report');
SELECT internal.test_rejects($$DELETE FROM pages.slugs WHERE slug_key = 'atian'$$, 'API deletes a name');
SELECT internal.test_rejects($$UPDATE moderation.bans SET reason = 'rewritten'$$, 'API rewrites a ban reason');
SELECT internal.test_rejects($$UPDATE config.settings SET min_value = '1' WHERE key = 'log.retention.audit_days'$$, 'API lowers a retention floor');
SELECT internal.test_rejects($$SELECT internal.purge_expired()$$, 'API runs the purge');
SELECT set_config('internal.purge', 'on', true);
SELECT internal.test_rejects($$DELETE FROM audit.events$$, 'API deletes audit events with the purge flag set');
SELECT set_config('internal.purge', '', true);
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION vrcpage_maintenance;
SELECT internal.test_rejects($$SELECT internal.purge_expired()$$, 'maintenance calls the purge directly');
RESET SESSION AUTHORIZATION;

-------------------------------------------------------------------------------
-- 5. History records exactly what changed, and who changed it.
-------------------------------------------------------------------------------

SET SESSION AUTHORIZATION vrcpage_api;
SELECT set_config('app.request_id', '00000000-0000-7000-8000-000000000f01', true),
       set_config('app.actor_type', 'account', true),
       set_config('app.actor_account_id', '00000000-0000-7000-8000-00000000000e', true);
UPDATE pages.links SET label = 'Twitch channel' WHERE id = '00000000-0000-7000-8000-0000000000e2';

-- A pooled connection that once set a context value reads it back as '' later.
SELECT set_config('app.request_id', '00000000-0000-7000-8000-000000000f02', true),
       set_config('app.actor_account_id', '', true);
UPDATE pages.links SET label = 'Twitch' WHERE id = '00000000-0000-7000-8000-0000000000e2';

-- A refresh that only changes the snapshot is not history.
SELECT set_config('app.request_id', '00000000-0000-7000-8000-000000000f03', true);
UPDATE vrchat.users SET bio = 'a new bio', fetched_at = now() WHERE id = 'usr_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
RESET SESSION AUTHORIZATION;

DO $$
DECLARE
  change audit.row_changes;
BEGIN
  SELECT * INTO STRICT change FROM audit.row_changes
   WHERE request_id = '00000000-0000-7000-8000-000000000f01';
  ASSERT change.operation = 'update' AND change.table_name = 'links', 'one update to links';
  ASSERT change.old_values = '{"label": "Twitch"}' AND change.new_values = '{"label": "Twitch channel"}', 'only the changed column';
  ASSERT change.actor_account_id = '00000000-0000-7000-8000-00000000000e', 'actor from app context';
  ASSERT change.db_role = 'vrcpage_api', 'db role recorded';

  SELECT * INTO STRICT change FROM audit.row_changes
   WHERE request_id = '00000000-0000-7000-8000-000000000f02';
  ASSERT change.actor_account_id IS NULL, 'empty context reads as NULL';

  ASSERT NOT EXISTS (SELECT 1 FROM audit.row_changes WHERE request_id = '00000000-0000-7000-8000-000000000f03'),
    'snapshot-only refresh writes no history';
  RAISE NOTICE 'ok    history records only changed columns and the actor';
END
$$;

-------------------------------------------------------------------------------
-- 6. One name pool, case-insensitive, with holds; expired holds are reclaimed by UPDATE.
-------------------------------------------------------------------------------

SET SESSION AUTHORIZATION vrcpage_api;
SELECT internal.test_rejects($$INSERT INTO pages.slugs (slug_key, slug, page_id, role)
                               VALUES ('editor1', 'EDITOR1', '00000000-0000-7000-8000-0000000000c1', 'alias')$$,
                             'alias reuses another page''s name in other capitals');
SELECT internal.test_rejects($$INSERT INTO pages.slugs (slug_key, slug, page_id, role)
                               VALUES ('nightmarket', 'NIGHTMARKET', '00000000-0000-7000-8000-0000000000c1', 'primary')$$,
                             'user page takes a held group name');
SELECT internal.test_rejects($$INSERT INTO pages.slugs (slug_key, slug, page_id, role)
                               VALUES ('abc', 'ABD', '00000000-0000-7000-8000-0000000000c1', 'alias')$$,
                             'key that does not match the name');
SELECT internal.test_rejects($$INSERT INTO pages.slugs (slug_key, slug, page_id, role)
                               VALUES ('second', 'second', '00000000-0000-7000-8000-0000000000c1', 'primary')$$,
                             'second primary name on one page');
RESET SESSION AUTHORIZATION;

UPDATE pages.slugs SET released_at = now() - interval '100 days', blocked_until = now() - interval '1 day'
 WHERE slug_key = 'atian';

SET SESSION AUTHORIZATION vrcpage_api;
UPDATE pages.slugs
   SET slug = 'ATIAN', page_id = '00000000-0000-7000-8000-0000000000c1', role = 'alias',
       claimed_at = now(), released_at = NULL, blocked_until = NULL
 WHERE slug_key = 'atian' AND page_id IS NULL AND blocked_until < now();
RESET SESSION AUTHORIZATION;

DO $$
BEGIN
  ASSERT (SELECT page_id FROM pages.slugs WHERE slug_key = 'atian') = '00000000-0000-7000-8000-0000000000c1',
    'expired hold reclaimed';
  RAISE NOTICE 'ok    names: one pool, case-insensitive, held, reclaimable';
END
$$;

-------------------------------------------------------------------------------
-- 7. Bans: a banned VRChat user cannot connect; an expired ban is lifted before a new one.
-------------------------------------------------------------------------------

INSERT INTO moderation.bans (subject_type, vrchat_user_id, reason, public_reason) VALUES
  ('vrchat_user', 'usr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'test', 'Test ban.');
INSERT INTO moderation.bans (subject_type, vrchat_user_id, reason, public_reason, created_at, expires_at) VALUES
  ('vrchat_user', 'usr_99999999-9999-4999-8999-999999999999', 'test', 'Test ban.',
   now() - interval '10 days', now() - interval '1 day');

SET SESSION AUTHORIZATION vrcpage_api;
SELECT internal.test_rejects($$INSERT INTO vrchat.users (id, account_id, display_name, fetched_at)
                               VALUES ('usr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '00000000-0000-7000-8000-00000000000f', 'Banned', now())$$,
                             'banned VRChat user connects');
SELECT internal.test_rejects($$INSERT INTO moderation.bans (subject_type, vrchat_user_id, reason, public_reason)
                               VALUES ('vrchat_user', 'usr_99999999-9999-4999-8999-999999999999', 'again', 'Again.')$$,
                             'new ban while the expired one is still open');
UPDATE moderation.bans SET lifted_at = now(), lift_reason = 'expired'
 WHERE vrchat_user_id = 'usr_99999999-9999-4999-8999-999999999999' AND lifted_at IS NULL;
INSERT INTO moderation.bans (subject_type, vrchat_user_id, reason, public_reason)
VALUES ('vrchat_user', 'usr_99999999-9999-4999-8999-999999999999', 'again', 'Again.');
SELECT internal.test_rejects($$INSERT INTO moderation.bans (subject_type, vrchat_user_id, reason, public_reason)
                               VALUES ('vrchat_user', 'usr_77777777-7777-4777-8777-777777777777', 'x', '   ')$$,
                             'ban with a blank public reason');
RESET SESSION AUTHORIZATION;

DO $$
BEGIN
  ASSERT NOT EXISTS (SELECT 1 FROM moderation.active_bans WHERE vrchat_user_id = 'usr_dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    'lifted ban is not active';
  ASSERT EXISTS (SELECT 1 FROM moderation.active_bans WHERE vrchat_user_id = 'usr_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    'open ban is active';
  RAISE NOTICE 'ok    bans block connecting and re-banning works after lifting';
END
$$;

-------------------------------------------------------------------------------
-- 8. Config values are type-checked and bounded; retention cannot drop below its floor.
-------------------------------------------------------------------------------

SET SESSION AUTHORIZATION vrcpage_api;
SELECT internal.test_rejects($$UPDATE config.settings SET value = '"three"' WHERE key = 'slug.min_length'$$, 'string in an int setting');
SELECT internal.test_rejects($$UPDATE config.settings SET value = '2.5' WHERE key = 'slug.min_length'$$, 'fraction in an int setting');
SELECT internal.test_rejects($$UPDATE config.settings SET value = '30' WHERE key = 'log.retention.audit_days'$$, 'retention below its floor');
SELECT internal.test_rejects($$UPDATE config.settings SET value = '["ok", 1]' WHERE key = 'slug.reserved'$$, 'number in a string list');
UPDATE config.settings SET value = '120' WHERE key = 'log.retention.audit_days';
RESET SESSION AUTHORIZATION;

DO $$
BEGIN
  ASSERT (SELECT value FROM config.settings WHERE key = 'log.retention.audit_days') = '120', 'valid value accepted';
  ASSERT EXISTS (SELECT 1 FROM audit.row_changes WHERE table_name = 'settings'
                  AND row_key = '{"key": "log.retention.audit_days"}' AND old_values = '{"value": 90}'),
    'config change recorded with its old value';
  RAISE NOTICE 'ok    config validation and history';
END
$$;

-------------------------------------------------------------------------------
-- 9. Links can be reordered across statements in one transaction.
-------------------------------------------------------------------------------

SET SESSION AUTHORIZATION vrcpage_api;
UPDATE pages.links SET position = 1 WHERE id = '00000000-0000-7000-8000-0000000000e2';
UPDATE pages.links SET position = 0 WHERE id = '00000000-0000-7000-8000-0000000000e3';
SET CONSTRAINTS pages.links_page_position_key IMMEDIATE;
SELECT internal.test_rejects($$INSERT INTO pages.links (page_id, position, url)
                               VALUES ('00000000-0000-7000-8000-0000000000e1', 5, 'http://insecure.example')$$,
                             'non-https link');
RESET SESSION AUTHORIZATION;

DO $$ BEGIN RAISE NOTICE 'ok    links reorder in one transaction'; END $$;

-------------------------------------------------------------------------------
-- 10. Maintenance runs as its own role and keeps partitions ahead.
-------------------------------------------------------------------------------

SET SESSION AUTHORIZATION vrcpage_api;
SELECT internal.ensure_partitions();
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION vrcpage_maintenance;
SELECT internal.run_maintenance();
RESET SESSION AUTHORIZATION;

DO $$
DECLARE
  utc_now timestamp := now() AT TIME ZONE 'UTC';
BEGIN
  ASSERT to_regclass('audit.events_' || to_char(utc_now + interval '1 month', 'YYYYMM')) IS NOT NULL, 'next month of audit.events';
  ASSERT to_regclass('audit.row_changes_' || to_char(utc_now + interval '1 month', 'YYYYMM')) IS NOT NULL, 'next month of row_changes';
  ASSERT to_regclass('pages.views_' || to_char(utc_now + interval '30 days', 'YYYYMMDD')) IS NOT NULL, 'next 30 days of views';
  ASSERT EXISTS (SELECT 1 FROM audit.events WHERE action = 'maintenance.completed'), 'maintenance logged itself';
  RAISE NOTICE 'ok    maintenance runs and partitions are ahead';
END
$$;

-------------------------------------------------------------------------------
-- 11. The views work for the API and readonly roles; neither can read secrets.
-------------------------------------------------------------------------------

SET SESSION AUTHORIZATION vrcpage_readonly;
SELECT count(*) FROM vrchat.budget_today;
SELECT count(*) FROM pages.page_overview;
SELECT count(*) FROM moderation.active_bans;
SELECT count(*) FROM audit.row_changes;
SELECT id, expires_at, ip_address FROM auth.sessions;
SELECT internal.test_rejects($$SELECT token FROM auth.sessions$$, 'readonly reads session tokens');
SELECT internal.test_rejects($$SELECT access_token FROM auth.identities$$, 'readonly reads OAuth tokens');
SELECT internal.test_rejects($$SELECT value FROM auth.verifications$$, 'readonly reads sign-in codes');
SELECT internal.test_rejects($$UPDATE pages.pages SET visibility = 'private'$$, 'readonly writes');
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION vrcpage_api;
SELECT count(*) FROM vrchat.budget_today;
SELECT count(*) FROM pages.page_overview;
SELECT internal.test_rejects($$SELECT token FROM auth.sessions$$, 'API reads session tokens');
SELECT internal.test_rejects($$SELECT password FROM auth.identities$$, 'API reads passwords');
RESET SESSION AUTHORIZATION;

DO $$ BEGIN RAISE NOTICE 'ok    views readable, secrets hidden'; END $$;

ROLLBACK;
