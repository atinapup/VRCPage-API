-- migrate:up

-- What an owner decides about their Socials: which links show, and whether
-- the Socials page is there at all.

-- No limit anyone should meet: the setting stays only as a ceiling against
-- abuse.
UPDATE config.settings
   SET value = '100', max_value = '200',
       description = 'Links added on vrc.page per page. A ceiling against abuse, not a limit anyone should meet.'
 WHERE key = 'links.custom.max_per_page';

ALTER TABLE pages.links
  ADD COLUMN is_hidden boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN pages.links.is_hidden IS 'Kept on the page''s list but not shown to visitors.';

-- VRChat's bio and group links have no row of their own, so hiding one is
-- remembered by what makes it that link: host without www, path without a
-- trailing slash, and query (linkIdentity in src/pages/links.ts).
CREATE TABLE pages.hidden_links (
  page_id uuid NOT NULL REFERENCES pages.pages ON DELETE CASCADE,
  identity text NOT NULL CHECK (char_length(identity) BETWEEN 1 AND 2100),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, identity)
);
COMMENT ON TABLE pages.hidden_links IS 'VRChat links a page''s owner chose not to show, by link identity.';

CREATE TRIGGER record_change AFTER INSERT OR UPDATE OR DELETE ON pages.hidden_links
  FOR EACH ROW EXECUTE FUNCTION internal.record_row_change('page_id,identity');

GRANT SELECT, INSERT, DELETE ON pages.hidden_links TO vrcpage_api;
GRANT SELECT ON pages.hidden_links TO vrcpage_readonly;

ALTER TABLE pages.pages
  ADD COLUMN socials_enabled boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN pages.pages.socials_enabled IS 'False: no Socials page; vrc.page/<name>/socials goes to the profile.';

-- migrate:down

ALTER TABLE pages.pages DROP COLUMN socials_enabled;
DROP TABLE pages.hidden_links;
ALTER TABLE pages.links DROP COLUMN is_hidden;
UPDATE config.settings
   SET value = '8', max_value = '50', description = 'Links added on vrc.page per page.'
 WHERE key = 'links.custom.max_per_page';
