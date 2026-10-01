-- migrate:up

-- "What's new": short notes about changes to vrc.page, written by an admin
-- and shown once to each signed-in account when they are published.

CREATE SCHEMA news;
COMMENT ON SCHEMA news IS 'Updates about vrc.page itself, and the pictures and clips in them.';
GRANT USAGE ON SCHEMA news TO vrcpage_api, vrcpage_readonly;

-- A picture or clip in an update. Pictures (GIFs included) are re-encoded to
-- WebP by the API, keeping any animation; clips are stored as uploaded. All
-- are served at <website>/updates/media/<sha256 hex>.<webp|mp4|webm>.
CREATE TABLE news.media (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  sha256 internal.sha256 NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type IN ('image/webp', 'video/mp4', 'video/webm')),
  bytes bytea NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 26214400 AND octet_length(bytes) = byte_size),
  width integer CHECK (width > 0),
  height integer CHECK (height > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE news.media ALTER COLUMN bytes SET STORAGE EXTERNAL;
COMMENT ON TABLE news.media IS 'Pictures and clips in updates, deduplicated by hash.';

CREATE TABLE news.updates (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  media_id uuid REFERENCES news.media ON DELETE SET NULL,
  published_at timestamptz,
  created_by uuid REFERENCES auth.accounts ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE news.updates IS 'Notes about changes to vrc.page. A draft until published_at is set.';
CREATE INDEX ON news.updates (published_at DESC) WHERE published_at IS NOT NULL;
CREATE INDEX ON news.updates (media_id);
CREATE INDEX ON news.updates (created_by);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON news.updates
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();
CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON news.updates
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('id');

GRANT SELECT, INSERT, UPDATE, DELETE ON news.updates TO vrcpage_api;
GRANT SELECT, INSERT, DELETE ON news.media TO vrcpage_api;
GRANT SELECT ON ALL TABLES IN SCHEMA news TO vrcpage_readonly;

-- migrate:down

DROP SCHEMA news CASCADE;
