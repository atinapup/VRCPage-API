-- migrate:up

-- Nightly upkeep. internal.run_maintenance() is the only entry point; the API's
-- scheduler calls it as vrcpage_maintenance (or `npm run db:maintain` by hand).
-- Every age comes from log.retention.*, whose floors stop anyone shortening them.

CREATE FUNCTION internal.retention_cutoff(setting_key text) RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT now() - make_interval(days => internal.setting(setting_key)::integer)
$$;

-- Adds daily totals for every complete UTC day not rolled up yet.
CREATE FUNCTION internal.rollup_views() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  today date := (now() AT TIME ZONE 'UTC')::date;
  from_day date;
  added integer;
BEGIN
  SELECT coalesce(
           max(day) + 1,
           (SELECT min(occurred_at AT TIME ZONE 'UTC')::date FROM pages.views)
         )
    INTO from_day
    FROM pages.view_daily;
  IF from_day IS NULL OR from_day >= today THEN
    RETURN 0;
  END IF;

  INSERT INTO pages.view_daily (page_id, day, views, unique_visitors)
  SELECT v.page_id,
         (v.occurred_at AT TIME ZONE 'UTC')::date,
         count(*),
         count(DISTINCT v.visitor_hash)
    FROM pages.views v
    JOIN pages.pages p ON p.id = v.page_id
   WHERE v.occurred_at >= from_day::timestamp AT TIME ZONE 'UTC'
     AND v.occurred_at < today::timestamp AT TIME ZONE 'UTC'
   GROUP BY 1, 2
  ON CONFLICT (page_id, day) DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END
$$;

-- Removes whatever has outlived its retention. The internal.purge flag is what
-- lets internal.forbid_change() accept these DELETEs; it is switched on here and
-- off again before returning (an error aborts the transaction, flag and all).
-- A function-level SET clause would be tidier, but Postgres only lets
-- superusers store custom settings on a function.
CREATE FUNCTION internal.purge_expired() RETURNS jsonb
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

CREATE FUNCTION internal.run_maintenance() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  summary jsonb;
  removed bigint;
BEGIN
  summary := jsonb_build_object(
    'partitions_created', internal.ensure_partitions(),
    'views_rolled_up', internal.rollup_views()
  );
  summary := summary || internal.purge_expired();

  DELETE FROM auth.sessions WHERE expires_at < now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('sessions', removed);

  DELETE FROM auth.verifications WHERE expires_at < now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('verifications', removed);

  DELETE FROM auth.rate_limits
   WHERE last_request < (extract(epoch FROM now() - interval '1 day') * 1000)::bigint;
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('rate_limits', removed);

  DELETE FROM pages.slugs WHERE page_id IS NULL AND blocked_until < now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('expired_name_holds', removed);

  UPDATE vrchat.claim_codes
     SET status = 'expired', resolved_at = now()
   WHERE status = 'pending' AND expires_at < now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  summary := summary || jsonb_build_object('claim_codes_expired', removed);

  INSERT INTO audit.events (actor_type, action, result, metadata)
  VALUES ('system', 'maintenance.completed', 'success', summary);

  RETURN summary;
END
$$;
COMMENT ON FUNCTION internal.run_maintenance() IS 'Nightly: partitions, view rollup, retention purge, expired sessions/codes/name holds. Returns what it did.';
GRANT EXECUTE ON FUNCTION internal.run_maintenance() TO vrcpage_maintenance;

-- migrate:down

DROP FUNCTION internal.run_maintenance();
DROP FUNCTION internal.purge_expired();
DROP FUNCTION internal.rollup_views();
DROP FUNCTION internal.retention_cutoff(text);
