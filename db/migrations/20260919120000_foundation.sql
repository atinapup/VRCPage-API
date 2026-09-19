-- migrate:up

-- Foundation: shared types, the trigger functions every table uses, and the two
-- audit logs. See docs/database.md for the conventions this file sets up.

-- Functions are not executable by everyone. Each migration grants EXECUTE to
-- the roles that need it, and nothing else can call them.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE SCHEMA internal;
COMMENT ON SCHEMA internal IS 'Shared domains, trigger functions and maintenance. No tables.';
CREATE SCHEMA audit;
COMMENT ON SCHEMA audit IS 'Append-only logs: who did what (events) and exactly what changed (row_changes).';

GRANT USAGE ON SCHEMA internal TO vrcpage_api, vrcpage_maintenance, vrcpage_readonly;
GRANT USAGE ON SCHEMA audit TO vrcpage_api, vrcpage_readonly;

-- Time-ordered ids. Postgres 18 has uuidv7() built in; 15 to 17 get a small
-- equivalent, so every column default below is the same on both.
DO $do$
BEGIN
  IF current_setting('server_version_num')::int >= 180000 THEN
    EXECUTE $f$
      CREATE FUNCTION internal.uuidv7() RETURNS uuid
      LANGUAGE sql VOLATILE PARALLEL SAFE
      AS 'SELECT pg_catalog.uuidv7()'
    $f$;
  ELSE
    EXECUTE $f$
      CREATE FUNCTION internal.uuidv7() RETURNS uuid
      LANGUAGE plpgsql VOLATILE PARALLEL SAFE SET search_path = ''
      AS $body$
      DECLARE
        unix_ms bytea := substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
        uuid_bytes bytea := uuid_send(gen_random_uuid());
      BEGIN
        uuid_bytes := overlay(uuid_bytes PLACING unix_ms FROM 1 FOR 6);
        -- Version 7 in the high nibble of byte 6; gen_random_uuid() already set the variant.
        uuid_bytes := set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 112);
        RETURN encode(uuid_bytes, 'hex')::uuid;
      END
      $body$
    $f$;
  END IF;
END
$do$;
COMMENT ON FUNCTION internal.uuidv7() IS 'Default for every uuid primary key: time-ordered, so new rows land at the end of the index.';
GRANT EXECUTE ON FUNCTION internal.uuidv7() TO vrcpage_api, vrcpage_auth;

CREATE DOMAIN internal.sha256 AS bytea
  CONSTRAINT sha256_length_check CHECK (octet_length(VALUE) = 32);
CREATE DOMAIN internal.country_code AS text
  -- Two characters from Cloudflare's cf-ipcountry header, which includes T1 for Tor.
  CONSTRAINT country_code_format_check CHECK (VALUE ~ '^[A-Z0-9]{2}$');
CREATE DOMAIN internal.email AS text
  CONSTRAINT email_format_check CHECK (
    VALUE = lower(VALUE)
    AND char_length(VALUE) <= 254
    AND VALUE ~ '^[^@[:space:]]+@[^@[:space:]]+$'
  );

-- Keeps updated_at honest without the application having to remember it.
CREATE FUNCTION internal.set_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Guards the append-only tables. The only way a row leaves is a DELETE made
-- inside internal.purge_expired(), which sets internal.purge for its own
-- duration. Roles without DELETE privilege never get that far.
CREATE FUNCTION internal.forbid_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('internal.purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '%.% is append-only; % is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE TYPE audit.actor_type AS ENUM ('account', 'staff', 'anonymous', 'system');
CREATE TYPE audit.result AS ENUM ('success', 'failure', 'denied', 'rate_limited');
CREATE TYPE audit.retention_class AS ENUM ('standard', 'security');
CREATE TYPE audit.row_operation AS ENUM ('insert', 'update', 'delete');

CREATE TABLE audit.events (
  id uuid NOT NULL DEFAULT internal.uuidv7(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id uuid,
  actor_type audit.actor_type NOT NULL,
  actor_account_id uuid,
  session_id uuid,
  ip inet,
  ip_country internal.country_code,
  user_agent text CHECK (char_length(user_agent) <= 1024),
  action text NOT NULL
    CONSTRAINT events_action_format_check CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  target_type text CHECK (target_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  target_id text CHECK (char_length(target_id) <= 200),
  result audit.result NOT NULL DEFAULT 'success',
  retention audit.retention_class NOT NULL DEFAULT 'standard',
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

COMMENT ON TABLE audit.events IS 'Every action by every actor, including failures and denials. Append-only, partitioned by month.';
COMMENT ON COLUMN audit.events.ip IS 'Full IP, written for security events only (spec section 14).';
COMMENT ON COLUMN audit.events.retention IS 'standard: kept log.retention.audit_days. security: kept log.retention.security_days.';
COMMENT ON COLUMN audit.events.metadata IS 'Action-specific detail. Never holds a secret.';

CREATE INDEX ON audit.events (actor_account_id, occurred_at DESC);
CREATE INDEX ON audit.events (ip, occurred_at DESC) WHERE ip IS NOT NULL;
CREATE INDEX ON audit.events (action, occurred_at DESC);
CREATE INDEX ON audit.events (request_id);
CREATE INDEX ON audit.events (target_type, target_id, occurred_at DESC);

CREATE TABLE audit.row_changes (
  id uuid NOT NULL DEFAULT internal.uuidv7(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  tx_id bigint NOT NULL,
  request_id uuid,
  actor_type audit.actor_type,
  actor_account_id uuid,
  db_role text NOT NULL,
  schema_name text NOT NULL,
  table_name text NOT NULL,
  operation audit.row_operation NOT NULL,
  row_key jsonb NOT NULL,
  old_values jsonb,
  new_values jsonb,
  PRIMARY KEY (id, changed_at),
  CONSTRAINT row_changes_values_check CHECK (
    (operation = 'insert' AND old_values IS NULL AND new_values IS NOT NULL)
    OR (operation = 'update' AND old_values IS NOT NULL AND new_values IS NOT NULL)
    OR (operation = 'delete' AND old_values IS NOT NULL AND new_values IS NULL)
  )
) PARTITION BY RANGE (changed_at);

COMMENT ON TABLE audit.row_changes IS 'Exact history of every tracked table, written only by internal.record_row_change(). Append-only, partitioned by month.';
COMMENT ON COLUMN audit.row_changes.actor_type IS 'From app.actor_type. NULL when the write carried no app context (Better Auth, manual psql).';
COMMENT ON COLUMN audit.row_changes.db_role IS 'session_user: the login that made the change, even through cascades.';
COMMENT ON COLUMN audit.row_changes.old_values IS 'Update: only the changed columns. Delete: the whole row, minus ignored columns.';

CREATE INDEX ON audit.row_changes (schema_name, table_name, row_key, changed_at DESC);
CREATE INDEX ON audit.row_changes (actor_account_id, changed_at DESC);
CREATE INDEX ON audit.row_changes (request_id);

CREATE TRIGGER forbid_change BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION internal.forbid_change();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON audit.events
  FOR EACH STATEMENT EXECUTE FUNCTION internal.forbid_change();
CREATE TRIGGER forbid_change BEFORE UPDATE OR DELETE ON audit.row_changes
  FOR EACH ROW EXECUTE FUNCTION internal.forbid_change();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON audit.row_changes
  FOR EACH STATEMENT EXECUTE FUNCTION internal.forbid_change();

-- History trigger. Attached to every tracked table as
--   internal.record_row_change('<key columns>', '<ignored columns>')
-- with comma-separated lists. Ignored columns (secrets and churn) are never
-- copied, and an update that only touched ignored columns records nothing.
-- SECURITY DEFINER so no application role can write history directly.
CREATE FUNCTION internal.record_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  key_columns text[] := string_to_array(TG_ARGV[0], ',');
  ignored text[] := coalesce(string_to_array(nullif(TG_ARGV[1], ''), ','), '{}') || ARRAY['updated_at'];
  full_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  old_row jsonb;
  new_row jsonb;
  row_key jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD) - ignored; END IF;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW) - ignored; END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(o.key, o.value), jsonb_object_agg(n.key, n.value)
      INTO old_row, new_row
      FROM jsonb_each(old_row) o
      JOIN jsonb_each(new_row) n ON n.key = o.key
     WHERE n.value IS DISTINCT FROM o.value;
    IF old_row IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT jsonb_object_agg(k, full_row -> k) INTO row_key FROM unnest(key_columns) AS k;

  INSERT INTO audit.row_changes (
    tx_id, request_id, actor_type, actor_account_id, db_role,
    schema_name, table_name, operation, row_key, old_values, new_values
  ) VALUES (
    pg_current_xact_id()::text::bigint,
    nullif(current_setting('app.request_id', true), '')::uuid,
    nullif(current_setting('app.actor_type', true), '')::audit.actor_type,
    nullif(current_setting('app.actor_account_id', true), '')::uuid,
    session_user,
    TG_TABLE_SCHEMA, TG_TABLE_NAME, lower(TG_OP)::audit.row_operation,
    row_key, old_row, new_row
  );
  RETURN NULL;
END
$$;

-- Creates the coming partitions of the three partitioned tables. There is no
-- DEFAULT partition on purpose: a missing period fails loudly instead of
-- piling rows where retention never reaches them. Harmless to run any time;
-- it only ever creates.
-- ponytail: the table list is written here; move it to a table if it grows past three.
CREATE FUNCTION internal.ensure_partitions() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  spec record;
  first_period timestamp;
  lower_bound timestamp;
  upper_bound timestamp;
  partition_name text;
  created integer := 0;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('audit', 'events',      'month', 3),
      ('audit', 'row_changes', 'month', 3),
      ('pages', 'views',       'day',   60)
    ) AS t (schema_name, table_name, period, ahead)
  LOOP
    CONTINUE WHEN to_regclass(format('%I.%I', spec.schema_name, spec.table_name)) IS NULL;
    first_period := date_trunc(spec.period, now() AT TIME ZONE 'UTC');

    FOR i IN 0 .. spec.ahead LOOP
      lower_bound := first_period + (i || ' ' || spec.period)::interval;
      upper_bound := lower_bound + ('1 ' || spec.period)::interval;
      partition_name := spec.table_name || '_'
        || to_char(lower_bound, CASE spec.period WHEN 'day' THEN 'YYYYMMDD' ELSE 'YYYYMM' END);
      CONTINUE WHEN to_regclass(format('%I.%I', spec.schema_name, partition_name)) IS NOT NULL;

      EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
        spec.schema_name, partition_name, spec.schema_name, spec.table_name,
        lower_bound::text || '+00', upper_bound::text || '+00'
      );
      -- Row triggers are inherited from the parent; statement triggers are not.
      EXECUTE format(
        'CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION internal.forbid_change()',
        spec.schema_name, partition_name
      );
      created := created + 1;
    END LOOP;
  END LOOP;
  RETURN created;
END
$$;
COMMENT ON FUNCTION internal.ensure_partitions() IS 'Creates upcoming partitions (3 months of audit, 60 days of views). Runs nightly, at API start and after migrations.';
GRANT EXECUTE ON FUNCTION internal.ensure_partitions() TO vrcpage_api;

SELECT internal.ensure_partitions();

GRANT SELECT, INSERT ON audit.events TO vrcpage_api;
GRANT SELECT ON audit.row_changes TO vrcpage_api;
GRANT SELECT ON audit.events, audit.row_changes TO vrcpage_readonly;

-- migrate:down

DROP SCHEMA audit CASCADE;
DROP SCHEMA internal CASCADE;
ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
