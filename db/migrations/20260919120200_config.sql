-- migrate:up

-- Every operational limit (spec section 13), plus the versioned legal documents
-- and who accepted which version.

CREATE SCHEMA config;
COMMENT ON SCHEMA config IS 'Tunable settings and the versioned terms and privacy policy.';
GRANT USAGE ON SCHEMA config TO vrcpage_api, vrcpage_readonly;

CREATE TYPE config.value_type AS ENUM ('int', 'float', 'bool', 'string', 'string_list', 'json');
CREATE TYPE config.legal_document_kind AS ENUM ('terms', 'privacy');

-- Bounds mean the value for numbers and the length for strings.
CREATE FUNCTION internal.setting_is_valid(value jsonb, value_type config.value_type, min_value jsonb, max_value jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = ''
AS $$
DECLARE
  measured numeric;
BEGIN
  CASE value_type
    WHEN 'int', 'float' THEN
      IF jsonb_typeof(value) <> 'number' THEN RETURN false; END IF;
      measured := value::numeric;
      IF value_type = 'int' AND measured % 1 <> 0 THEN RETURN false; END IF;
    WHEN 'string' THEN
      IF jsonb_typeof(value) <> 'string' THEN RETURN false; END IF;
      measured := char_length(value #>> '{}');
    WHEN 'bool' THEN
      RETURN jsonb_typeof(value) = 'boolean';
    WHEN 'string_list' THEN
      RETURN jsonb_typeof(value) = 'array'
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value) AS e WHERE jsonb_typeof(e) <> 'string');
    WHEN 'json' THEN
      RETURN true;
  END CASE;

  RETURN (min_value IS NULL OR measured >= min_value::numeric)
     AND (max_value IS NULL OR measured <= max_value::numeric);
END
$$;
GRANT EXECUTE ON FUNCTION internal.setting_is_valid(jsonb, config.value_type, jsonb, jsonb) TO vrcpage_api;

CREATE TABLE config.settings (
  key text PRIMARY KEY
    CONSTRAINT settings_key_format_check CHECK (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  value jsonb NOT NULL,
  value_type config.value_type NOT NULL,
  min_value jsonb,
  max_value jsonb,
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  category text NOT NULL CHECK (category ~ '^[a-z_]{1,32}$'),
  updated_by uuid REFERENCES auth.accounts ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settings_value_check CHECK (internal.setting_is_valid(value, value_type, min_value, max_value))
);
COMMENT ON TABLE config.settings IS 'Every tunable limit. Rows come from migrations; the API may change value only, within min_value and max_value.';

-- Read a setting inside the database. A missing key is a bug, not a default.
CREATE FUNCTION internal.setting(setting_key text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT value INTO result FROM config.settings WHERE key = setting_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'config.settings has no key %', setting_key;
  END IF;
  RETURN result;
END
$$;
GRANT EXECUTE ON FUNCTION internal.setting(text) TO vrcpage_api, vrcpage_readonly;

INSERT INTO config.settings (key, value, value_type, min_value, max_value, category, description) VALUES
  ('vrchat.api.enabled',                     'true',     'bool',        NULL,   NULL,     'vrchat',    'Global kill switch for every VRChat API call.'),
  ('vrchat.api.min_interval_seconds',        '60',       'int',         '60',   '3600',   'vrchat',    'Minimum spacing between two VRChat calls, site-wide. VRChat asks for at least 60.'),
  ('vrchat.api.backoff_initial_seconds',     '300',      'int',         '60',   '86400',  'vrchat',    'First wait after a 429.'),
  ('vrchat.api.backoff_max_seconds',         '21600',    'int',         '300',  '86400',  'vrchat',    'Longest wait after repeated 429s.'),
  ('vrchat.api.user_agent',                  '"vrc.page/1.0 (contact@vrc.page)"', 'string', '1', '200', 'vrchat', 'User-Agent sent to VRChat, with a contact address.'),
  ('vrchat.api.circuit_breaker_threshold',   '3',        'int',         '1',    '20',     'vrchat',    'Consecutive auth failures that pause all VRChat traffic.'),

  ('budget.daily_calls',                     '1440',     'int',         '0',    '1440',   'budget',    'VRChat calls per UTC day, shared by every lane.'),
  ('budget.lane.verification_pct',           '25',       'int',         '0',    '100',    'budget',    'Share of the daily calls for claim-code checks.'),
  ('budget.lane.scheduled_pct',              '55',       'int',         '0',    '100',    'budget',    'Share of the daily calls for scheduled refreshes.'),
  ('budget.lane.manual_pct',                 '15',       'int',         '0',    '100',    'budget',    'Share of the daily calls for owner-requested refreshes.'),
  ('budget.lane.headroom_pct',               '5',        'int',         '0',    '100',    'budget',    'Share of the daily calls kept for retries and debugging.'),

  ('refresh.tier.hot.view_window_hours',     '48',       'int',         '1',    '720',    'refresh',   'A page viewed within this many hours is hot.'),
  ('refresh.tier.hot.interval_hours',        '24',       'int',         '1',    '720',    'refresh',   'How often a hot page is refreshed.'),
  ('refresh.tier.warm.view_window_days',     '30',       'int',         '1',    '365',    'refresh',   'A page viewed within this many days is warm.'),
  ('refresh.tier.warm.interval_days',        '7',        'int',         '1',    '365',    'refresh',   'How often a warm page is refreshed.'),
  ('refresh.tier.cold.interval_days',        '30',       'int',         '1',    '365',    'refresh',   'How often a cold page is refreshed.'),
  ('refresh.tier.dormant.view_window_days',  '180',      'int',         '1',    '3650',   'refresh',   'A page not viewed for this many days is dormant: refreshed on demand only.'),
  ('refresh.manual.cooldown_seconds',        '900',      'int',         '60',   '86400',  'refresh',   'Wait between two manual refreshes of the same page.'),
  ('refresh.manual.daily_cap_per_account',   '10',       'int',         '0',    '1000',   'refresh',   'Manual refreshes one account can request per UTC day.'),
  ('refresh.manual.owner_only',              'true',     'bool',        NULL,   NULL,     'refresh',   'Only the page owner sees the refresh button.'),

  ('claim.code.length',                      '6',        'int',         '4',    '12',     'claim',     'Characters after "vrcpage-" in a claim code.'),
  ('claim.code.alphabet',                    '"ABCDEFGHJKMNPQRSTUVWXYZ23456789"', 'string', '16', '64', 'claim', 'Characters a claim code is drawn from. No 0/O or 1/I/L.'),
  ('claim.code.ttl_seconds',                 '900',      'int',         '60',   '86400',  'claim',     'How long a claim code stays valid.'),
  ('claim.code.max_check_attempts',          '8',        'int',         '1',    '50',     'claim',     'Checks allowed per code before it is used up.'),
  ('claim.code.check_cooldown_seconds',      '60',       'int',         '0',    '3600',   'claim',     'Wait between two checks by the same account.'),

  ('slug.min_length',                        '3',        'int',         '1',    '64',     'slug',      'Shortest allowed page name.'),
  ('slug.max_length',                        '30',       'int',         '1',    '64',     'slug',      'Longest allowed page name.'),
  ('slug.change_cooldown_days',              '30',       'int',         '0',    '365',    'slug',      'Wait between two renames, counted from the first change.'),
  ('slug.tombstone_days',                    '90',       'int',         '0',    '3650',   'slug',      'How long a released name is held before anyone can claim it.'),
  ('slug.reserved',                          '["api","admin","login","signup","about","privacy","terms","help","support","settings","dashboard","vrchat","vrc","official","staff","_next","static","assets","onboarding","dev","socials","groups","invite","link"]',
                                                         'string_list', NULL,   NULL,     'slug',      'Names nobody can claim (routes and impersonation).'),
  ('slug.blocked_substrings',                '["vrchat","official"]', 'string_list', NULL, NULL, 'slug', 'A name containing any of these is refused as impersonation.'),
  ('slug.aliases.max_per_page',              '5',        'int',         '0',    '100',    'slug',      'Aliases a moderator or partner can add per page. Admins are unlimited.'),

  ('auth.email_code.length',                 '6',        'int',         '4',    '12',     'auth',      'Digits in an email sign-in code.'),
  ('auth.email_code.ttl_seconds',            '600',      'int',         '60',   '3600',   'auth',      'How long an email sign-in code stays valid.'),
  ('auth.email_code.max_attempts',           '5',        'int',         '1',    '20',     'auth',      'Wrong guesses allowed per email code.'),
  ('auth.email_code.resend_cooldown_seconds','60',       'int',         '0',    '3600',   'auth',      'Wait before another code can be sent to the same address.'),
  ('auth.discord.enabled',                   'true',     'bool',        NULL,   NULL,     'auth',      'Discord sign-in is offered.'),
  ('auth.github.enabled',                    'true',     'bool',        NULL,   NULL,     'auth',      'GitHub sign-in is offered.'),
  ('auth.signups_open',                      'true',     'bool',        NULL,   NULL,     'auth',      'New accounts can be created.'),

  ('links.custom.enabled',                   'true',     'bool',        NULL,   NULL,     'links',     'Owners and editors can add links on vrc.page.'),
  ('links.custom.max_per_page',              '8',        'int',         '0',    '50',     'links',     'Links added on vrc.page per page.'),
  ('links.custom.label_max_length',          '40',       'int',         '1',    '100',    'links',     'Longest link label.'),
  ('links.custom.blocked_hosts',             '[]',       'string_list', NULL,   NULL,     'links',     'Hosts a link may not point to.'),

  ('groups.max_per_user',                    '3',        'int',         '0',    '50',     'groups',    'Groups one account can own. Groups it edits do not count.'),
  ('groups.editors.max_per_group',           '5',        'int',         '0',    '50',     'groups',    'Editors per group, pending invites included.'),

  ('domains.enabled',                        'false',    'bool',        NULL,   NULL,     'domains',   'Custom domains can be added.'),
  ('domains.max_per_page',                   '1',        'int',         '0',    '10',     'domains',   'Custom domains per page.'),

  ('reports.enabled',                        'true',     'bool',        NULL,   NULL,     'reports',   'Visitors can report a page.'),
  ('reports.max_per_visitor_per_day',        '5',        'int',         '1',    '100',    'reports',   'Reports one visitor can file per UTC day.'),

  -- Each default is also the floor, so retention can never be shortened
  -- from the API to make logs disappear early. Shortening needs a migration.
  ('log.retention.audit_days',               '90',       'int',         '90',   '3650',   'retention', 'Days standard audit events are kept.'),
  ('log.retention.security_days',            '365',      'int',         '365',  '3650',   'retention', 'Days security audit events are kept.'),
  ('log.retention.row_changes_days',         '365',      'int',         '365',  '3650',   'retention', 'Days row change history is kept.'),
  ('log.retention.profile_view_days',        '90',       'int',         '90',   '3650',   'retention', 'Days raw page views are kept (daily totals are kept forever).'),
  ('log.retention.api_calls_days',           '90',       'int',         '90',   '3650',   'retention', 'Days the VRChat call log is kept.'),
  ('log.retention.mail_days',                '90',       'int',         '90',   '3650',   'retention', 'Days sent mail and Resend events are kept.'),
  ('log.retention.jobs_days',                '30',       'int',         '30',   '3650',   'retention', 'Days finished VRChat jobs are kept.'),
  ('log.retention.claim_codes_days',         '90',       'int',         '90',   '3650',   'retention', 'Days resolved claim codes are kept.'),
  ('log.retention.reports_days',             '365',      'int',         '365',  '3650',   'retention', 'Days resolved reports are kept (longer while linked to an active ban).'),
  ('log.retention.bans_days',                '365',      'int',         '365',  '3650',   'retention', 'Days a lifted or expired ban and its evidence are kept.'),

  ('site.maintenance_mode',                  'false',    'bool',        NULL,   NULL,     'site',      'Show the maintenance message instead of the site.'),
  ('site.maintenance_message',               '""',       'string',      '0',    '500',    'site',      'Message shown during maintenance.');

CREATE TABLE config.legal_documents (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  kind config.legal_document_kind NOT NULL,
  version text NOT NULL CHECK (version ~ '^[0-9A-Za-z._-]{1,32}$'),
  published_at timestamptz NOT NULL,
  url text NOT NULL CHECK (url ~ '^https://' AND char_length(url) <= 2048),
  content_sha256 internal.sha256 NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, version)
);
COMMENT ON TABLE config.legal_documents IS 'Every published version of the terms and privacy policy. Insert-only; the hash fixes exactly what was published.';

CREATE TABLE config.legal_acceptances (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  account_id uuid NOT NULL REFERENCES auth.accounts ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES config.legal_documents,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  session_id uuid,
  UNIQUE (account_id, document_id)
);
COMMENT ON TABLE config.legal_acceptances IS 'Which account accepted which document version, and when. Insert-only.';
CREATE INDEX ON config.legal_acceptances (document_id);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON config.settings
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON config.settings
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('key');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON config.legal_acceptances
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('id');

GRANT SELECT ON config.settings TO vrcpage_api;
GRANT UPDATE (value, updated_by) ON config.settings TO vrcpage_api;
GRANT SELECT, INSERT ON config.legal_documents, config.legal_acceptances TO vrcpage_api;
GRANT SELECT ON ALL TABLES IN SCHEMA config TO vrcpage_readonly;

-- migrate:down

DROP FUNCTION internal.setting(text);
DROP SCHEMA config CASCADE;
