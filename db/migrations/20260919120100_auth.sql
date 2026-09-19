-- migrate:up

-- Accounts and sign-in. The first five tables belong to Better Auth, mapped
-- onto these names with modelName/fields (see docs/database.md). The API's
-- Better Auth pool logs in as vrcpage_auth with search_path = auth.

CREATE SCHEMA auth;
COMMENT ON SCHEMA auth IS 'vrc.page accounts, sessions, sign-in identities, staff roles and preferences.';
GRANT USAGE ON SCHEMA auth TO vrcpage_api, vrcpage_auth, vrcpage_readonly;

CREATE TYPE auth.role AS ENUM ('admin', 'moderator', 'partner');

CREATE TABLE auth.accounts (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  email internal.email NOT NULL UNIQUE,
  is_email_verified boolean NOT NULL DEFAULT false,
  name text NOT NULL CHECK (char_length(name) <= 200),
  image text CHECK (char_length(image) <= 2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE auth.accounts IS 'A vrc.page login (Better Auth "user"). Deleting one cascades to everything the account owns.';
COMMENT ON COLUMN auth.accounts.name IS 'Can be empty: an email sign-up has no name.';

CREATE TABLE auth.sessions (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  account_id uuid NOT NULL REFERENCES auth.accounts ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE auth.sessions IS 'Signed-in sessions (Better Auth "session"). Expired rows are removed nightly.';
COMMENT ON COLUMN auth.sessions.ip_address IS 'Text, not inet: Better Auth may write an empty string.';
CREATE INDEX ON auth.sessions (account_id);
CREATE INDEX ON auth.sessions (expires_at);
CREATE INDEX ON auth.sessions (ip_address) WHERE ip_address <> '';

CREATE TABLE auth.identities (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  account_id uuid NOT NULL REFERENCES auth.accounts ON DELETE CASCADE,
  provider_id text NOT NULL CHECK (provider_id ~ '^[a-z0-9_-]{1,64}$'),
  provider_account_id text NOT NULL CHECK (char_length(provider_account_id) BETWEEN 1 AND 255),
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, provider_account_id)
);
COMMENT ON TABLE auth.identities IS 'Discord and GitHub sign-ins attached to an account (Better Auth "account"). Tokens are encrypted by Better Auth.';
CREATE INDEX ON auth.identities (account_id);

CREATE TABLE auth.verifications (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE auth.verifications IS 'Short-lived secrets such as hashed email sign-in codes (Better Auth "verification").';
CREATE INDEX ON auth.verifications (identifier);
CREATE INDEX ON auth.verifications (expires_at);

CREATE TABLE auth.rate_limits (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  key text NOT NULL UNIQUE,
  count integer NOT NULL,
  last_request bigint NOT NULL
);
COMMENT ON TABLE auth.rate_limits IS 'Better Auth "rateLimit" counters, shared by every API instance. Also backs the email resend cooldown.';
COMMENT ON COLUMN auth.rate_limits.last_request IS 'Unix time in milliseconds, as Better Auth writes it.';

CREATE TABLE auth.account_roles (
  account_id uuid NOT NULL REFERENCES auth.accounts ON DELETE CASCADE,
  role auth.role NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid REFERENCES auth.accounts ON DELETE SET NULL,
  note text CHECK (char_length(note) <= 500),
  PRIMARY KEY (account_id, role)
);
COMMENT ON TABLE auth.account_roles IS 'Staff and special roles. admin: everything, unlimited aliases. moderator: moderation, 5 aliases. partner: 5 aliases, custom domains.';

CREATE TABLE auth.notification_preferences (
  account_id uuid PRIMARY KEY REFERENCES auth.accounts ON DELETE CASCADE,
  notify_group_invites boolean NOT NULL DEFAULT true,
  notify_page_changes boolean NOT NULL DEFAULT true,
  notify_product_news boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE auth.notification_preferences IS 'Email preferences. No row means the defaults.';

CREATE TRIGGER set_updated_at BEFORE UPDATE ON auth.accounts
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON auth.sessions
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON auth.identities
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON auth.verifications
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON auth.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON auth.accounts
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('id');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON auth.identities
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change(
    'id', 'access_token,refresh_token,id_token,access_token_expires_at,refresh_token_expires_at,password');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON auth.account_roles
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('account_id,role');
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON auth.notification_preferences
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('account_id');

-- Better Auth owns its five tables.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON auth.accounts, auth.sessions, auth.identities, auth.verifications, auth.rate_limits
  TO vrcpage_auth;

-- The API reads accounts, revokes sessions (bans), and manages roles and preferences.
-- It never sees session tokens, OAuth tokens, passwords or codes.
GRANT SELECT ON auth.accounts TO vrcpage_api;
GRANT SELECT (id, account_id, expires_at, ip_address, user_agent, created_at, updated_at)
  ON auth.sessions TO vrcpage_api;
GRANT DELETE ON auth.sessions TO vrcpage_api;
GRANT SELECT (id, account_id, provider_id, provider_account_id, scope, created_at, updated_at)
  ON auth.identities TO vrcpage_api;
GRANT SELECT, INSERT, DELETE ON auth.account_roles TO vrcpage_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.notification_preferences TO vrcpage_api;

GRANT SELECT ON auth.accounts, auth.rate_limits, auth.account_roles, auth.notification_preferences
  TO vrcpage_readonly;
GRANT SELECT (id, account_id, expires_at, ip_address, user_agent, created_at, updated_at)
  ON auth.sessions TO vrcpage_readonly;
GRANT SELECT (id, account_id, provider_id, provider_account_id, scope, created_at, updated_at)
  ON auth.identities TO vrcpage_readonly;
GRANT SELECT (id, identifier, expires_at, created_at, updated_at)
  ON auth.verifications TO vrcpage_readonly;

-- migrate:down

DROP SCHEMA auth CASCADE;
