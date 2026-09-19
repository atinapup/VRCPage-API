-- migrate:up

-- Public pages at vrc.page/<name>, for users and groups, and everything
-- attached to one: its names, links, editors, custom domains and views.

CREATE SCHEMA pages;
COMMENT ON SCHEMA pages IS 'Published pages, their names and aliases, links, editors, custom domains and views.';
GRANT USAGE ON SCHEMA pages TO vrcpage_api, vrcpage_readonly;

CREATE TYPE pages.page_kind AS ENUM ('user', 'group');
CREATE TYPE pages.visibility AS ENUM ('public', 'unlisted', 'private');
CREATE TYPE pages.refresh_tier AS ENUM ('hot', 'warm', 'cold', 'dormant');
CREATE TYPE pages.slug_role AS ENUM ('primary', 'alias');
CREATE TYPE pages.invite_status AS ENUM ('pending', 'accepted', 'declined', 'revoked');
CREATE TYPE pages.domain_status AS ENUM ('pending', 'active', 'failed', 'disabled');
CREATE TYPE pages.tls_status AS ENUM ('pending', 'active', 'failed');

CREATE TABLE pages.pages (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  kind pages.page_kind NOT NULL,
  vrchat_user_id vrchat.user_id UNIQUE REFERENCES vrchat.users ON DELETE CASCADE,
  vrchat_group_id vrchat.group_id UNIQUE REFERENCES vrchat.groups ON DELETE CASCADE,
  visibility pages.visibility NOT NULL DEFAULT 'public',
  slug_changed_at timestamptz,
  refresh_tier pages.refresh_tier NOT NULL DEFAULT 'hot',
  last_viewed_at timestamptz,
  next_refresh_at timestamptz NOT NULL DEFAULT now(),
  hidden_at timestamptz,
  hidden_reason text CHECK (char_length(hidden_reason) BETWEEN 1 AND 1000),
  hidden_by uuid REFERENCES auth.accounts ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pages_source_check CHECK (
    (kind = 'user' AND vrchat_user_id IS NOT NULL AND vrchat_group_id IS NULL)
    OR (kind = 'group' AND vrchat_group_id IS NOT NULL AND vrchat_user_id IS NULL)
  ),
  -- hidden_by is left out on purpose: it becomes NULL if that staff account is deleted.
  CONSTRAINT pages_hidden_check CHECK ((hidden_at IS NULL) = (hidden_reason IS NULL))
);
COMMENT ON TABLE pages.pages IS 'A public page for one connected VRChat user or one claimed group. The owner is derived through vrchat.users.account_id.';
COMMENT ON COLUMN pages.pages.slug_changed_at IS 'When the primary name last changed; the rename cooldown counts from here.';
COMMENT ON COLUMN pages.pages.hidden_at IS 'Moderator takedown. The owner cannot undo it.';
CREATE INDEX ON pages.pages (next_refresh_at) WHERE hidden_at IS NULL;
CREATE INDEX ON pages.pages (hidden_by);

CREATE TABLE pages.slugs (
  slug_key text PRIMARY KEY,
  slug text NOT NULL CONSTRAINT slugs_slug_format_check CHECK (slug ~ '^[A-Za-z0-9_-]{1,64}$'),
  page_id uuid REFERENCES pages.pages,
  role pages.slug_role NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  blocked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slugs_key_check CHECK (slug_key = lower(slug)),
  CONSTRAINT slugs_state_check CHECK (
    (page_id IS NOT NULL AND released_at IS NULL AND blocked_until IS NULL)
    OR (page_id IS NULL AND released_at IS NOT NULL AND blocked_until IS NOT NULL)
  )
);
COMMENT ON TABLE pages.slugs IS 'The one shared pool of names: primaries, aliases and held (released) names. slug_key makes it case-insensitive.';
COMMENT ON COLUMN pages.slugs.slug IS 'The name as typed, which is how it is shown.';
COMMENT ON COLUMN pages.slugs.page_id IS 'NULL while the name is held after release. Reclaiming an expired hold updates this row.';
COMMENT ON COLUMN pages.slugs.role IS 'primary: the page''s address. alias: redirects (308) to the primary.';
CREATE UNIQUE INDEX slugs_one_primary_per_page_idx ON pages.slugs (page_id) WHERE role = 'primary' AND page_id IS NOT NULL;
CREATE INDEX ON pages.slugs (page_id) WHERE page_id IS NOT NULL;
CREATE INDEX ON pages.slugs (blocked_until) WHERE page_id IS NULL;

-- Every way a page can disappear (disconnect, unclaim, account deletion,
-- direct delete) holds its names, so nobody can take them over right away.
CREATE FUNCTION pages.hold_slugs_of_deleted_page() RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  UPDATE pages.slugs
     SET page_id = NULL,
         released_at = now(),
         blocked_until = now() + make_interval(days => internal.setting('slug.tombstone_days')::integer)
   WHERE page_id = OLD.id;
  RETURN OLD;
END
$$;
CREATE TRIGGER hold_slugs BEFORE DELETE ON pages.pages
  FOR EACH ROW EXECUTE FUNCTION pages.hold_slugs_of_deleted_page();

CREATE TABLE pages.links (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  page_id uuid NOT NULL REFERENCES pages.pages ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position >= 0),
  url text NOT NULL CONSTRAINT links_url_check CHECK (url ~ '^https://' AND char_length(url) <= 2048),
  label text CHECK (char_length(label) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT links_page_position_key UNIQUE (page_id, position) DEFERRABLE INITIALLY DEFERRED
);
COMMENT ON TABLE pages.links IS 'Links added on vrc.page, shown after the ones mirrored from VRChat. Duplicates are refused by the API''s link identity rule.';
COMMENT ON COLUMN pages.links.url IS 'Normalized https URL.';

CREATE TABLE pages.editor_invites (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  page_id uuid NOT NULL REFERENCES pages.pages ON DELETE CASCADE,
  invited_account_id uuid NOT NULL REFERENCES auth.accounts ON DELETE CASCADE,
  invited_by_account_id uuid NOT NULL REFERENCES auth.accounts ON DELETE CASCADE,
  status pages.invite_status NOT NULL DEFAULT 'pending',
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT editor_invites_responded_check CHECK ((status = 'pending') = (responded_at IS NULL)),
  CONSTRAINT editor_invites_not_self_check CHECK (invited_account_id <> invited_by_account_id)
);
COMMENT ON TABLE pages.editor_invites IS 'Invitations from a group page''s owner to become an editor. Seats (editors plus pending) are capped by the API.';
CREATE UNIQUE INDEX editor_invites_one_pending_idx ON pages.editor_invites (page_id, invited_account_id) WHERE status = 'pending';
CREATE INDEX ON pages.editor_invites (invited_account_id) WHERE status = 'pending';
CREATE INDEX ON pages.editor_invites (invited_by_account_id);

CREATE TABLE pages.editors (
  page_id uuid NOT NULL REFERENCES pages.pages ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES auth.accounts ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, account_id)
);
COMMENT ON TABLE pages.editors IS 'Accounts that may change a group page''s links. The owner is never listed here.';
CREATE INDEX ON pages.editors (account_id);

CREATE TABLE pages.custom_domains (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  page_id uuid NOT NULL REFERENCES pages.pages ON DELETE CASCADE,
  hostname text NOT NULL UNIQUE
    CONSTRAINT custom_domains_hostname_check CHECK (
      hostname = lower(hostname)
      AND char_length(hostname) <= 253
      AND hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$'
      AND hostname !~ '(^|\.)vrc\.page$'
    ),
  status pages.domain_status NOT NULL DEFAULT 'pending',
  verification_token text NOT NULL CHECK (char_length(verification_token) BETWEEN 16 AND 128),
  verified_at timestamptz,
  tls_status pages.tls_status NOT NULL DEFAULT 'pending',
  provider_hostname_id text UNIQUE CHECK (char_length(provider_hostname_id) <= 128),
  last_checked_at timestamptz,
  last_error text CHECK (char_length(last_error) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE pages.custom_domains IS 'A page served on someone''s own domain (Cloudflare for SaaS). Gated by role and domains.enabled.';
CREATE INDEX ON pages.custom_domains (page_id);

CREATE TABLE pages.views (
  page_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  visitor_hash internal.sha256 NOT NULL,
  country internal.country_code,
  referrer_host text CHECK (char_length(referrer_host) <= 253)
) PARTITION BY RANGE (occurred_at);
COMMENT ON TABLE pages.views IS 'One row per public page view. Append-only, partitioned by day, dropped after log.retention.profile_view_days.';
COMMENT ON COLUMN pages.views.visitor_hash IS 'HMAC of the IP with a monthly key derived from a secret the API holds. Counts uniques; cannot be reversed here.';
CREATE INDEX ON pages.views (page_id, occurred_at);

CREATE TRIGGER forbid_change BEFORE UPDATE OR DELETE ON pages.views
  FOR EACH ROW EXECUTE FUNCTION internal.forbid_change();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON pages.views
  FOR EACH STATEMENT EXECUTE FUNCTION internal.forbid_change();

SELECT internal.ensure_partitions();

CREATE TABLE pages.view_daily (
  page_id uuid NOT NULL REFERENCES pages.pages ON DELETE CASCADE,
  day date NOT NULL,
  views integer NOT NULL CHECK (views >= 0),
  unique_visitors integer NOT NULL CHECK (unique_visitors BETWEEN 0 AND views),
  PRIMARY KEY (page_id, day)
);
COMMENT ON TABLE pages.view_daily IS 'Daily view totals per page (UTC days), rolled up nightly so they outlive the raw views.';

CREATE VIEW pages.page_overview WITH (security_invoker = true) AS
SELECT p.id AS page_id,
       p.kind,
       primary_slug.slug AS primary_slug,
       coalesce(u.display_name, g.name) AS display_name,
       coalesce(u.id::text, g.id::text) AS vrchat_id,
       owner.id AS owner_account_id,
       owner.email AS owner_email,
       p.visibility,
       p.hidden_at IS NOT NULL AS is_hidden,
       p.refresh_tier,
       p.last_viewed_at,
       p.created_at
  FROM pages.pages p
  LEFT JOIN vrchat.users u ON u.id = p.vrchat_user_id
  LEFT JOIN vrchat.groups g ON g.id = p.vrchat_group_id
  LEFT JOIN vrchat.users claimer ON claimer.id = g.claimed_by_vrchat_user_id
  JOIN auth.accounts owner ON owner.id = coalesce(u.account_id, claimer.account_id)
  LEFT JOIN pages.slugs primary_slug ON primary_slug.page_id = p.id AND primary_slug.role = 'primary';
COMMENT ON VIEW pages.page_overview IS 'Who is this page: its name, source, owner and state in one row.';

CREATE TRIGGER set_updated_at BEFORE UPDATE ON pages.pages
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON pages.slugs
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON pages.links
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON pages.editor_invites
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON pages.custom_domains
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON pages.pages
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('id', 'last_viewed_at,next_refresh_at,refresh_tier');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON pages.slugs
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('slug_key');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON pages.links
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('id');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON pages.editor_invites
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('id');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON pages.editors
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('page_id,account_id');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON pages.custom_domains
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('id', 'last_checked_at');

GRANT SELECT, INSERT, UPDATE, DELETE
  ON pages.pages, pages.links, pages.editor_invites, pages.editors, pages.custom_domains
  TO vrcpage_api;
-- Names are never deleted by the API: they move between active and held.
GRANT SELECT, INSERT, UPDATE ON pages.slugs TO vrcpage_api;
GRANT SELECT, INSERT ON pages.views TO vrcpage_api;
GRANT SELECT ON pages.view_daily, pages.page_overview TO vrcpage_api;
GRANT SELECT ON ALL TABLES IN SCHEMA pages TO vrcpage_readonly;

-- migrate:down

DROP SCHEMA pages CASCADE;
