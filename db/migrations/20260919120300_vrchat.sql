-- migrate:up

-- Everything that comes from VRChat: connected users and claimed groups with
-- their latest snapshot, our copies of their images, the proof codes, and a
-- log of every call made to VRChat.

CREATE SCHEMA vrchat;
COMMENT ON SCHEMA vrchat IS 'Connected VRChat users, claimed groups, claim codes, the request queue and the VRChat call log.';
GRANT USAGE ON SCHEMA vrchat TO vrcpage_api, vrcpage_readonly;

CREATE DOMAIN vrchat.user_id AS text
  CONSTRAINT user_id_format_check CHECK (
    VALUE ~ '^usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR VALUE ~ '^[A-Za-z0-9]{10}$'
  );
COMMENT ON DOMAIN vrchat.user_id IS 'usr_<uuid> in lowercase, or a legacy 10-character id (case-sensitive), stored as VRChat returns it.';
CREATE DOMAIN vrchat.group_id AS text
  CONSTRAINT group_id_format_check CHECK (
    VALUE ~ '^grp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

CREATE TYPE vrchat.target_kind AS ENUM ('user', 'group');
CREATE TYPE vrchat.claim_status AS ENUM ('pending', 'succeeded', 'expired', 'exhausted', 'cancelled', 'denied');
CREATE TYPE vrchat.user_status AS ENUM ('active', 'join_me', 'ask_me', 'busy', 'offline');
CREATE TYPE vrchat.fetch_error AS ENUM ('not_found', 'rate_limited', 'unavailable');
CREATE TYPE vrchat.group_privacy AS ENUM ('default', 'private');
CREATE TYPE vrchat.lane AS ENUM ('verification', 'scheduled', 'manual', 'headroom');
CREATE TYPE vrchat.endpoint AS ENUM ('get_user', 'get_group');
CREATE TYPE vrchat.call_outcome AS ENUM (
  'ok', 'not_found', 'rate_limited', 'auth_failed', 'server_error', 'network_error', 'timeout'
);

CREATE TABLE vrchat.images (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  sha256 internal.sha256 NOT NULL UNIQUE,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  byte_size integer NOT NULL CHECK (byte_size > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE vrchat.images IS 'Our R2 copies of VRChat icons and banners, deduplicated by hash. R2 keys are images/<sha256 hex>.webp|avif.';

CREATE TABLE vrchat.claim_codes (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  account_id uuid NOT NULL REFERENCES auth.accounts ON DELETE CASCADE,
  target_kind vrchat.target_kind NOT NULL,
  vrchat_user_id vrchat.user_id,
  vrchat_group_id vrchat.group_id,
  code text NOT NULL CHECK (code ~ '^vrcpage-[A-Z0-9]{4,12}$'),
  status vrchat.claim_status NOT NULL DEFAULT 'pending',
  denied_reason text CHECK (denied_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  check_count smallint NOT NULL DEFAULT 0 CHECK (check_count >= 0),
  last_checked_at timestamptz,
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_codes_target_check CHECK (
    (target_kind = 'user' AND vrchat_user_id IS NOT NULL AND vrchat_group_id IS NULL)
    OR (target_kind = 'group' AND vrchat_group_id IS NOT NULL AND vrchat_user_id IS NULL)
  ),
  CONSTRAINT claim_codes_denied_check CHECK ((status = 'denied') = (denied_reason IS NOT NULL)),
  CONSTRAINT claim_codes_resolved_check CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CONSTRAINT claim_codes_expiry_check CHECK (expires_at > created_at)
);
COMMENT ON TABLE vrchat.claim_codes IS 'vrcpage-XXXXXX proof codes, pasted into a VRChat bio (user) or group description (group).';
COMMENT ON COLUMN vrchat.claim_codes.denied_reason IS 'Why a matching code was still refused, e.g. already_connected, not_group_owner, group_private, banned.';
CREATE UNIQUE INDEX claim_codes_one_pending_idx ON vrchat.claim_codes (account_id, target_kind) WHERE status = 'pending';
CREATE INDEX ON vrchat.claim_codes (vrchat_user_id) WHERE vrchat_user_id IS NOT NULL;
CREATE INDEX ON vrchat.claim_codes (vrchat_group_id) WHERE vrchat_group_id IS NOT NULL;
CREATE INDEX ON vrchat.claim_codes (created_at);

CREATE TABLE vrchat.users (
  id vrchat.user_id PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES auth.accounts ON DELETE CASCADE,
  connected_at timestamptz NOT NULL DEFAULT now(),

  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 4000),
  bio_links text[] NOT NULL DEFAULT '{}' CHECK (cardinality(bio_links) <= 20),
  pronouns text CHECK (char_length(pronouns) <= 100),
  status vrchat.user_status NOT NULL DEFAULT 'offline',
  status_description text CHECK (char_length(status_description) <= 200),
  is_age_verified boolean NOT NULL DEFAULT false,
  trust_rank text CHECK (char_length(trust_rank) <= 64),
  represented_group_id vrchat.group_id,
  represented_group_name text CHECK (char_length(represented_group_name) <= 200),
  languages text[] NOT NULL DEFAULT '{}' CHECK (cardinality(languages) <= 20),
  icon_image_id uuid REFERENCES vrchat.images ON DELETE RESTRICT,
  banner_image_id uuid REFERENCES vrchat.images ON DELETE RESTRICT,

  fetched_at timestamptz NOT NULL,
  last_fetch_error vrchat.fetch_error,
  last_fetch_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_fetch_error_check CHECK ((last_fetch_error IS NULL) = (last_fetch_error_at IS NULL))
);
COMMENT ON TABLE vrchat.users IS 'A VRChat user connected to exactly one account: the connection plus the latest snapshot. Deleting the row disconnects it.';
COMMENT ON COLUMN vrchat.users.connected_at IS 'When the bio code matched: the GDPR consent record, with the link.succeeded audit event.';
COMMENT ON COLUMN vrchat.users.fetched_at IS 'Last successful read from VRChat.';
CREATE INDEX ON vrchat.users (icon_image_id);
CREATE INDEX ON vrchat.users (banner_image_id);

CREATE TABLE vrchat.groups (
  id vrchat.group_id PRIMARY KEY,
  claimed_by_vrchat_user_id vrchat.user_id NOT NULL REFERENCES vrchat.users ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT now(),

  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  short_code text NOT NULL CHECK (char_length(short_code) BETWEEN 1 AND 32),
  discriminator text NOT NULL CHECK (char_length(discriminator) BETWEEN 1 AND 32),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 8000),
  rules text CHECK (char_length(rules) <= 16000),
  links text[] NOT NULL DEFAULT '{}' CHECK (cardinality(links) <= 20),
  languages text[] NOT NULL DEFAULT '{}' CHECK (cardinality(languages) <= 20),
  member_count integer NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  is_verified boolean NOT NULL DEFAULT false,
  privacy vrchat.group_privacy NOT NULL,
  owner_vrchat_user_id vrchat.user_id NOT NULL,
  icon_image_id uuid REFERENCES vrchat.images ON DELETE RESTRICT,
  banner_image_id uuid REFERENCES vrchat.images ON DELETE RESTRICT,

  fetched_at timestamptz NOT NULL,
  last_fetch_error vrchat.fetch_error,
  last_fetch_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT groups_fetch_error_check CHECK ((last_fetch_error IS NULL) = (last_fetch_error_at IS NULL))
);
COMMENT ON TABLE vrchat.groups IS 'A claimed VRChat group plus its latest snapshot. Removed with the claimer''s VRChat connection.';
COMMENT ON COLUMN vrchat.groups.owner_vrchat_user_id IS 'The owner as VRChat reports it. The API unclaims the group when this stops matching the claimer.';
CREATE INDEX ON vrchat.groups (claimed_by_vrchat_user_id);
CREATE INDEX ON vrchat.groups (icon_image_id);
CREATE INDEX ON vrchat.groups (banner_image_id);

CREATE TABLE vrchat.api_calls (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  started_at timestamptz NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  lane vrchat.lane NOT NULL,
  job_id uuid,
  endpoint vrchat.endpoint NOT NULL,
  target_id text NOT NULL CHECK (char_length(target_id) <= 64),
  http_status smallint CHECK (http_status BETWEEN 100 AND 599),
  outcome vrchat.call_outcome NOT NULL,
  retry_after_seconds integer CHECK (retry_after_seconds >= 0),
  error text CHECK (char_length(error) <= 2000)
);
COMMENT ON TABLE vrchat.api_calls IS 'Every call made to VRChat (spec section 2). Append-only. Also the source of the daily budget.';
COMMENT ON COLUMN vrchat.api_calls.http_status IS 'NULL when no response arrived (network error or timeout).';
CREATE INDEX ON vrchat.api_calls (lane, started_at);
CREATE INDEX ON vrchat.api_calls (started_at);

CREATE TABLE vrchat.client_state (
  id boolean PRIMARY KEY DEFAULT true CONSTRAINT client_state_single_row_check CHECK (id),
  next_call_at timestamptz NOT NULL DEFAULT now(),
  backoff_seconds integer NOT NULL DEFAULT 0 CHECK (backoff_seconds >= 0),
  backoff_until timestamptz,
  consecutive_auth_failures smallint NOT NULL DEFAULT 0 CHECK (consecutive_auth_failures >= 0),
  circuit_opened_at timestamptz,
  circuit_reason text CHECK (char_length(circuit_reason) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE vrchat.client_state IS 'The one-row state of the VRChat client. SELECT ... FOR UPDATE on it is the site-wide one-call-at-a-time lock.';
INSERT INTO vrchat.client_state DEFAULT VALUES;

CREATE VIEW vrchat.budget_today WITH (security_invoker = true) AS
SELECT lane.lane,
       coalesce(used.calls, 0) AS calls_used,
       floor(
         internal.setting('budget.daily_calls')::numeric
         * internal.setting('budget.lane.' || lane.lane::text || '_pct')::numeric / 100
       )::integer AS calls_allowed
  FROM unnest(enum_range(NULL::vrchat.lane)) AS lane (lane)
  LEFT JOIN (
    SELECT c.lane, count(*)::integer AS calls
      FROM vrchat.api_calls c
     WHERE c.started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
     GROUP BY c.lane
  ) AS used ON used.lane = lane.lane;
COMMENT ON VIEW vrchat.budget_today IS 'VRChat calls per lane since midnight UTC, next to each lane''s cap.';

CREATE TRIGGER set_updated_at BEFORE UPDATE ON vrchat.claim_codes
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON vrchat.users
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON vrchat.groups
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON vrchat.client_state
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();

CREATE TRIGGER forbid_change BEFORE UPDATE OR DELETE ON vrchat.api_calls
  FOR EACH ROW EXECUTE FUNCTION internal.forbid_change();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON vrchat.api_calls
  FOR EACH STATEMENT EXECUTE FUNCTION internal.forbid_change();

-- History keeps the connection, not the snapshot: VRChat's data can be read
-- again, and keeping every old bio would be a privacy and volume problem.
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON vrchat.users
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('id',
    'display_name,bio,bio_links,pronouns,status,status_description,is_age_verified,trust_rank,'
    'represented_group_id,represented_group_name,languages,icon_image_id,banner_image_id,'
    'fetched_at,last_fetch_error,last_fetch_error_at');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON vrchat.groups
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('id',
    'name,short_code,discriminator,description,rules,links,languages,member_count,is_verified,'
    'privacy,owner_vrchat_user_id,icon_image_id,banner_image_id,fetched_at,last_fetch_error,last_fetch_error_at');

GRANT SELECT, INSERT, DELETE ON vrchat.images TO vrcpage_api;
GRANT SELECT, INSERT, UPDATE ON vrchat.claim_codes TO vrcpage_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON vrchat.users, vrchat.groups TO vrcpage_api;
GRANT SELECT, INSERT ON vrchat.api_calls TO vrcpage_api;
GRANT SELECT, UPDATE ON vrchat.client_state TO vrcpage_api;
GRANT SELECT ON vrchat.budget_today TO vrcpage_api;
GRANT SELECT ON ALL TABLES IN SCHEMA vrchat TO vrcpage_readonly;

-- migrate:down

DROP SCHEMA vrchat CASCADE;
