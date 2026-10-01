-- migrate:up

-- How the site looks for one account, and the last "What's new" it has seen.
-- The website mirrors the two display settings into a cookie of its own, so
-- they apply on every page as soon as it draws, for as long as the account
-- is signed in there.

CREATE TABLE auth.account_preferences (
  account_id uuid PRIMARY KEY REFERENCES auth.accounts ON DELETE CASCADE,
  high_contrast boolean NOT NULL DEFAULT false,
  dyslexia_font boolean NOT NULL DEFAULT false,
  updates_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE auth.account_preferences IS 'Display settings and the last update seen. No row means the defaults.';
COMMENT ON COLUMN auth.account_preferences.updates_seen_at IS 'Updates published after this are new to the account. NULL: its creation time.';

CREATE TRIGGER set_updated_at BEFORE UPDATE ON auth.account_preferences
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON auth.account_preferences
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('account_id');

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.account_preferences TO vrcpage_api;
GRANT SELECT ON auth.account_preferences TO vrcpage_readonly;

-- migrate:down

DROP TABLE auth.account_preferences;
