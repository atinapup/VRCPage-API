-- migrate:up

-- Bans, the evidence behind them, and reports from visitors.

CREATE SCHEMA moderation;
COMMENT ON SCHEMA moderation IS 'Bans, ban evidence and abuse reports.';
GRANT USAGE ON SCHEMA moderation TO vrcpage_api, vrcpage_readonly;

CREATE TYPE moderation.ban_subject AS ENUM ('account', 'vrchat_user', 'ip_range');
CREATE TYPE moderation.report_reason AS ENUM (
  'impersonation', 'harassment', 'hate', 'sexual_content', 'spam', 'malicious_link', 'minor_safety', 'other'
);
CREATE TYPE moderation.report_status AS ENUM ('open', 'in_review', 'actioned', 'dismissed');

CREATE TABLE moderation.bans (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  subject_type moderation.ban_subject NOT NULL,
  account_id uuid,
  vrchat_user_id vrchat.user_id,
  ip_range cidr,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  public_reason text NOT NULL
    CONSTRAINT bans_public_reason_check CHECK (btrim(public_reason) <> '' AND char_length(public_reason) <= 500),
  created_by uuid REFERENCES auth.accounts ON DELETE SET NULL,
  expires_at timestamptz,
  lifted_at timestamptz,
  lift_reason text CHECK (char_length(lift_reason) BETWEEN 1 AND 2000),
  lifted_by uuid REFERENCES auth.accounts ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bans_subject_check CHECK (
    num_nonnulls(account_id, vrchat_user_id, ip_range) = 1
    AND CASE subject_type
          WHEN 'account' THEN account_id IS NOT NULL
          WHEN 'vrchat_user' THEN vrchat_user_id IS NOT NULL
          ELSE ip_range IS NOT NULL
        END
  ),
  CONSTRAINT bans_expiry_check CHECK (expires_at > created_at),
  -- lifted_by is left out on purpose: it becomes NULL if that staff account is deleted.
  CONSTRAINT bans_lift_check CHECK ((lifted_at IS NULL) = (lift_reason IS NULL))
);
COMMENT ON TABLE moderation.bans IS 'Bans on an account, a VRChat user (preferred) or an IP range. Reason and subject are locked once written.';
COMMENT ON COLUMN moderation.bans.account_id IS 'No foreign key: a ban outlives the account it was placed on.';
COMMENT ON COLUMN moderation.bans.reason IS 'Internal. public_reason is what the banned person sees.';
COMMENT ON COLUMN moderation.bans.expires_at IS 'NULL means permanent.';
CREATE UNIQUE INDEX bans_one_open_account_idx ON moderation.bans (account_id) WHERE lifted_at IS NULL AND account_id IS NOT NULL;
CREATE UNIQUE INDEX bans_one_open_vrchat_user_idx ON moderation.bans (vrchat_user_id) WHERE lifted_at IS NULL AND vrchat_user_id IS NOT NULL;
CREATE UNIQUE INDEX bans_one_open_ip_range_idx ON moderation.bans (ip_range) WHERE lifted_at IS NULL AND ip_range IS NOT NULL;
CREATE INDEX ON moderation.bans (created_by);
CREATE INDEX ON moderation.bans (lifted_by);

CREATE VIEW moderation.active_bans WITH (security_invoker = true) AS
SELECT *
  FROM moderation.bans
 WHERE lifted_at IS NULL
   AND (expires_at IS NULL OR expires_at > now());
COMMENT ON VIEW moderation.active_bans IS 'The one definition of an active ban. An expired ban must be lifted (lift_reason = expired) before the same subject can be banned again.';

CREATE TABLE moderation.ban_evidence (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  ban_id uuid NOT NULL REFERENCES moderation.bans ON DELETE CASCADE,
  audit_event_id uuid,
  event_snapshot jsonb NOT NULL CHECK (jsonb_typeof(event_snapshot) = 'object'),
  note text CHECK (char_length(note) <= 2000),
  added_by uuid REFERENCES auth.accounts ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE moderation.ban_evidence IS 'Audit rows behind a ban, copied whole at the moment of the ban so they outlive log retention. Insert-only.';
CREATE INDEX ON moderation.ban_evidence (ban_id);
CREATE INDEX ON moderation.ban_evidence (added_by);

CREATE TABLE moderation.reports (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  page_id uuid REFERENCES pages.pages ON DELETE SET NULL,
  target_snapshot jsonb NOT NULL CHECK (jsonb_typeof(target_snapshot) = 'object'),
  reporter_account_id uuid REFERENCES auth.accounts ON DELETE SET NULL,
  reporter_visitor_hash internal.sha256 NOT NULL,
  reason moderation.report_reason NOT NULL,
  details text CHECK (char_length(details) <= 2000),
  status moderation.report_status NOT NULL DEFAULT 'open',
  assigned_to uuid REFERENCES auth.accounts ON DELETE SET NULL,
  resolved_by uuid REFERENCES auth.accounts ON DELETE SET NULL,
  resolved_at timestamptz,
  resolution_note text CHECK (char_length(resolution_note) <= 2000),
  ban_id uuid REFERENCES moderation.bans ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_resolved_check CHECK ((status IN ('actioned', 'dismissed')) = (resolved_at IS NOT NULL))
);
COMMENT ON TABLE moderation.reports IS 'Reports from visitors about a page. The snapshot keeps the page as it was when reported.';
COMMENT ON COLUMN moderation.reports.reporter_visitor_hash IS 'Same hash as pages.views.visitor_hash; set for every reporter, signed in or not, and used for the daily cap.';
CREATE INDEX reports_open_idx ON moderation.reports (status, created_at) WHERE status IN ('open', 'in_review');
CREATE INDEX ON moderation.reports (page_id);
CREATE INDEX ON moderation.reports (reporter_visitor_hash, created_at);
CREATE INDEX ON moderation.reports (reporter_account_id);
CREATE INDEX ON moderation.reports (assigned_to);
CREATE INDEX ON moderation.reports (resolved_by);
CREATE INDEX ON moderation.reports (ban_id);

-- A banned VRChat user cannot be connected again.
CREATE FUNCTION moderation.reject_banned_vrchat_user() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM moderation.active_bans WHERE vrchat_user_id = NEW.id) THEN
    RAISE EXCEPTION 'VRChat user % is banned', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'vrchat_user_banned';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER reject_banned BEFORE INSERT ON vrchat.users
  FOR EACH ROW EXECUTE FUNCTION moderation.reject_banned_vrchat_user();

CREATE TRIGGER set_updated_at BEFORE UPDATE ON moderation.bans
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON moderation.reports
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON moderation.bans
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('id');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON moderation.ban_evidence
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('id');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON moderation.reports
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('id');

-- Locked once written: the API may only lift or re-time a ban, and only
-- handle a report. Neither can be deleted from the API.
GRANT SELECT, INSERT ON moderation.bans TO vrcpage_api;
GRANT UPDATE (expires_at, lifted_at, lift_reason, lifted_by) ON moderation.bans TO vrcpage_api;
GRANT SELECT, INSERT ON moderation.ban_evidence TO vrcpage_api;
GRANT SELECT, INSERT ON moderation.reports TO vrcpage_api;
GRANT UPDATE (status, assigned_to, resolved_by, resolved_at, resolution_note, ban_id) ON moderation.reports TO vrcpage_api;
GRANT SELECT ON moderation.active_bans TO vrcpage_api;
GRANT SELECT ON ALL TABLES IN SCHEMA moderation TO vrcpage_readonly;

-- migrate:down

DROP SCHEMA moderation CASCADE;
