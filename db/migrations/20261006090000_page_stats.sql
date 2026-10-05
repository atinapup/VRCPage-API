-- migrate:up

-- Page stats. A visit is one load of a public page, named by a random id the
-- browser makes (visit_id). Its view goes in pages.views as before; what the
-- visitor then did, the links they opened and how long they stayed, goes in
-- pages.visit_events under the same id. Both are logs: append-only, daily
-- partitions, dropped after log.retention.profile_view_days.

ALTER TABLE pages.views ADD COLUMN visit_id uuid;
COMMENT ON COLUMN pages.views.visit_id IS 'Random id the browser made for this visit; ties the view to its rows in pages.visit_events.';

CREATE TABLE pages.visit_events (
  page_id uuid NOT NULL,
  visit_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('click', 'leave')),
  link_url text CHECK (char_length(link_url) <= 2048),
  seconds integer CHECK (seconds BETWEEN 0 AND 1800),
  CHECK (CASE kind
    WHEN 'click' THEN link_url IS NOT NULL AND seconds IS NULL
    WHEN 'leave' THEN seconds IS NOT NULL AND link_url IS NULL
  END)
) PARTITION BY RANGE (occurred_at);
COMMENT ON TABLE pages.visit_events IS 'What a visitor did on a public page: a link opened, or how long they stayed. Append-only, partitioned by day, dropped after log.retention.profile_view_days.';
COMMENT ON COLUMN pages.visit_events.link_url IS 'For a click: the page''s own copy of the link opened, never what the browser sent.';
COMMENT ON COLUMN pages.visit_events.seconds IS 'For a leave: seconds the page was visible, capped at 30 minutes.';
CREATE INDEX ON pages.visit_events (page_id, occurred_at);
CREATE INDEX ON pages.visit_events (visit_id);

CREATE TRIGGER forbid_change BEFORE UPDATE OR DELETE ON pages.visit_events
  FOR EACH ROW EXECUTE FUNCTION internal.forbid_change();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pages.visit_events
  FOR EACH STATEMENT EXECUTE FUNCTION internal.forbid_change();

GRANT SELECT, INSERT ON pages.visit_events TO vrcpage_api;
GRANT SELECT ON pages.visit_events TO vrcpage_readonly;

-- ponytail: the table list is written here (four now); move it to a table if it grows.
CREATE OR REPLACE FUNCTION internal.ensure_partitions() RETURNS integer
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
      ('audit', 'events',       'month', 3),
      ('audit', 'row_changes',  'month', 3),
      ('pages', 'views',        'day',   60),
      ('pages', 'visit_events', 'day',   60)
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
COMMENT ON FUNCTION internal.ensure_partitions() IS 'Creates upcoming partitions (3 months of audit, 60 days of views and visit events). Runs nightly, at API start and after migrations.';

SELECT internal.ensure_partitions();

CREATE OR REPLACE FUNCTION internal.purge_expired() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  summary jsonb := '{}';
  part record;
  period_end date;
  keep_days integer;
  dropped integer := 0;
  removed bigint;
BEGIN
  PERFORM set_config('internal.purge', 'on', true);

  -- Whole partitions past their table's longest retention.
  FOR part IN
    SELECT c.oid::regclass AS partition, c.relname, parent.relname AS parent_name
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class parent ON parent.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = parent.relnamespace
     WHERE (n.nspname, parent.relname) IN (('audit', 'events'), ('audit', 'row_changes'), ('pages', 'views'), ('pages', 'visit_events'))
  LOOP
    -- Partition names end in _YYYYMMDD (daily) or _YYYYMM (monthly).
    period_end := CASE
      WHEN part.relname ~ '_[0-9]{8}$' THEN to_date(right(part.relname, 8), 'YYYYMMDD') + 1
      ELSE (to_date(right(part.relname, 6), 'YYYYMM') + interval '1 month')::date
    END;
    keep_days := CASE part.parent_name
      WHEN 'events' THEN greatest(internal.setting('log.retention.audit_days')::integer,
                                  internal.setting('log.retention.security_days')::integer)
      WHEN 'row_changes' THEN internal.setting('log.retention.row_changes_days')::integer
      WHEN 'views' THEN internal.setting('log.retention.profile_view_days')::integer
      WHEN 'visit_events' THEN internal.setting('log.retention.profile_view_days')::integer
    END;
    IF period_end <= (now() AT TIME ZONE 'UTC')::date - keep_days THEN
      EXECUTE format('DROP TABLE %s', part.partition);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  summary := summary || jsonb_build_object('partitions_dropped', dropped);

  DELETE FROM audit.events
   WHERE retention = 'standard' AND occurred_at < internal.retention_cutoff('log.retention.audit_days');
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('audit_events', removed);

  DELETE FROM vrchat.api_calls WHERE started_at < internal.retention_cutoff('log.retention.api_calls_days');
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('api_calls', removed);

  DELETE FROM mail.events WHERE received_at < internal.retention_cutoff('log.retention.mail_days');
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('mail_events', removed);

  DELETE FROM mail.messages
   WHERE created_at < internal.retention_cutoff('log.retention.mail_days')
     AND status NOT IN ('queued', 'sending');
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('mail_messages', removed);

  DELETE FROM vrchat.jobs WHERE finished_at < internal.retention_cutoff('log.retention.jobs_days');
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('jobs', removed);

  DELETE FROM vrchat.claim_codes
   WHERE status <> 'pending' AND resolved_at < internal.retention_cutoff('log.retention.claim_codes_days');
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('claim_codes', removed);

  DELETE FROM moderation.reports r
   WHERE r.resolved_at < internal.retention_cutoff('log.retention.reports_days')
     AND NOT EXISTS (SELECT 1 FROM moderation.active_bans b WHERE b.id = r.ban_id);
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('reports', removed);

  -- Evidence goes with its ban (ON DELETE CASCADE). Permanent, unlifted bans stay.
  DELETE FROM moderation.bans
   WHERE coalesce(lifted_at, expires_at) < internal.retention_cutoff('log.retention.bans_days');
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('bans', removed);

  PERFORM set_config('internal.purge', 'off', true);
  RETURN summary;
END
$$;

-- migrate:down

CREATE OR REPLACE FUNCTION internal.purge_expired() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  summary jsonb := '{}';
  part record;
  period_end date;
  keep_days integer;
  dropped integer := 0;
  removed bigint;
BEGIN
  PERFORM set_config('internal.purge', 'on', true);

  -- Whole partitions past their table's longest retention.
  FOR part IN
    SELECT c.oid::regclass AS partition, c.relname, parent.relname AS parent_name
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class parent ON parent.oid = i.inhparent
      JOIN pg_namespace n ON n.oid = parent.relnamespace
     WHERE (n.nspname, parent.relname) IN (('audit', 'events'), ('audit', 'row_changes'), ('pages', 'views'))
  LOOP
    -- Partition names end in _YYYYMMDD (daily) or _YYYYMM (monthly).
    period_end := CASE
      WHEN part.relname ~ '_[0-9]{8}$' THEN to_date(right(part.relname, 8), 'YYYYMMDD') + 1
      ELSE (to_date(right(part.relname, 6), 'YYYYMM') + interval '1 month')::date
    END;
    keep_days := CASE part.parent_name
      WHEN 'events' THEN greatest(internal.setting('log.retention.audit_days')::integer,
                                  internal.setting('log.retention.security_days')::integer)
      WHEN 'row_changes' THEN internal.setting('log.retention.row_changes_days')::integer
      WHEN 'views' THEN internal.setting('log.retention.profile_view_days')::integer
    END;
    IF period_end <= (now() AT TIME ZONE 'UTC')::date - keep_days THEN
      EXECUTE format('DROP TABLE %s', part.partition);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  summary := summary || jsonb_build_object('partitions_dropped', dropped);

  DELETE FROM audit.events
   WHERE retention = 'standard' AND occurred_at < internal.retention_cutoff('log.retention.audit_days');
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('audit_events', removed);

  DELETE FROM vrchat.api_calls WHERE started_at < internal.retention_cutoff('log.retention.api_calls_days');
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('api_calls', removed);

  DELETE FROM mail.events WHERE received_at < internal.retention_cutoff('log.retention.mail_days');
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('mail_events', removed);

  DELETE FROM mail.messages
   WHERE created_at < internal.retention_cutoff('log.retention.mail_days')
     AND status NOT IN ('queued', 'sending');
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('mail_messages', removed);

  DELETE FROM vrchat.jobs WHERE finished_at < internal.retention_cutoff('log.retention.jobs_days');
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('jobs', removed);

  DELETE FROM vrchat.claim_codes
   WHERE status <> 'pending' AND resolved_at < internal.retention_cutoff('log.retention.claim_codes_days');
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('claim_codes', removed);

  DELETE FROM moderation.reports r
   WHERE r.resolved_at < internal.retention_cutoff('log.retention.reports_days')
     AND NOT EXISTS (SELECT 1 FROM moderation.active_bans b WHERE b.id = r.ban_id);
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('reports', removed);

  -- Evidence goes with its ban (ON DELETE CASCADE). Permanent, unlifted bans stay.
  DELETE FROM moderation.bans
   WHERE coalesce(lifted_at, expires_at) < internal.retention_cutoff('log.retention.bans_days');
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('bans', removed);

  PERFORM set_config('internal.purge', 'off', true);
  RETURN summary;
END
$$;

CREATE OR REPLACE FUNCTION internal.ensure_partitions() RETURNS integer
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

DROP TABLE pages.visit_events;
ALTER TABLE pages.views DROP COLUMN visit_id;
