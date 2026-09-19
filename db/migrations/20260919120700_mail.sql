-- migrate:up

-- Email through Resend: every message sent (and the outbox for ones that can
-- wait), the webhook events Resend reports back, and addresses we must not
-- mail. Templates and the sending worker come with the API.

CREATE SCHEMA mail;
COMMENT ON SCHEMA mail IS 'Outgoing email (Resend): messages, delivery events and suppressions.';
GRANT USAGE ON SCHEMA mail TO vrcpage_api, vrcpage_readonly;

CREATE TYPE mail.category AS ENUM ('auth', 'transactional', 'notification', 'product');
CREATE TYPE mail.message_status AS ENUM (
  'queued', 'sending', 'sent', 'delivered', 'delivery_delayed',
  'bounced', 'complained', 'failed', 'suppressed', 'cancelled'
);
CREATE TYPE mail.suppression_reason AS ENUM ('hard_bounce', 'complaint', 'manual');

CREATE TABLE mail.messages (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  account_id uuid REFERENCES auth.accounts ON DELETE SET NULL,
  to_email internal.email NOT NULL,
  template text NOT NULL CHECK (template ~ '^[a-z][a-z0-9_]{0,63}$'),
  category mail.category NOT NULL,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 300),
  props jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(props) = 'object'),
  status mail.message_status NOT NULL DEFAULT 'queued',
  idempotency_key text UNIQUE CHECK (char_length(idempotency_key) <= 256),
  resend_email_id text UNIQUE CHECK (char_length(resend_email_id) <= 128),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text CHECK (char_length(last_error) <= 2000),
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  bounced_at timestamptz,
  complained_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE mail.messages IS 'Every email, and the outbox for the ones that can wait (status queued). Sign-in codes are sent at once and logged without the code.';
COMMENT ON COLUMN mail.messages.props IS 'The data the template was rendered with. Never a secret.';
CREATE INDEX messages_outbox_idx ON mail.messages (scheduled_for) WHERE status = 'queued';
CREATE INDEX ON mail.messages (account_id);
CREATE INDEX ON mail.messages (created_at);

CREATE TABLE mail.events (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  message_id uuid,
  resend_email_id text CHECK (char_length(resend_email_id) <= 128),
  webhook_id text NOT NULL UNIQUE CHECK (char_length(webhook_id) <= 128),
  type text NOT NULL CHECK (type ~ '^[a-z]+(\.[a-z_]+)+$'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);
COMMENT ON TABLE mail.events IS 'Resend webhook events (email.sent, email.delivered, email.bounced, ...). Append-only.';
COMMENT ON COLUMN mail.events.webhook_id IS 'The svix-id header, so a webhook delivered twice is stored once.';
CREATE INDEX ON mail.events (message_id);
CREATE INDEX ON mail.events (resend_email_id);
CREATE INDEX ON mail.events (received_at);

CREATE TABLE mail.suppressions (
  email internal.email PRIMARY KEY,
  reason mail.suppression_reason NOT NULL,
  source_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE mail.suppressions IS 'Addresses we must not mail (hard bounce, complaint, or by hand). Deleting a row lifts it; history records that.';

CREATE TRIGGER set_updated_at BEFORE UPDATE ON mail.messages
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON mail.suppressions
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();

CREATE TRIGGER forbid_change BEFORE UPDATE OR DELETE ON mail.events
  FOR EACH ROW EXECUTE FUNCTION internal.forbid_change();
CREATE TRIGGER forbid_truncate BEFORE TRUNCATE ON mail.events
  FOR EACH STATEMENT EXECUTE FUNCTION internal.forbid_change();

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON mail.suppressions
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('email');

GRANT SELECT, INSERT, UPDATE ON mail.messages TO vrcpage_api;
GRANT SELECT, INSERT ON mail.events TO vrcpage_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON mail.suppressions TO vrcpage_api;
GRANT SELECT ON ALL TABLES IN SCHEMA mail TO vrcpage_readonly;

-- migrate:down

DROP SCHEMA mail CASCADE;
