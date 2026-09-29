-- migrate:up

-- An alias either sends the visitor on to the page's own name (308), or shows
-- the same page at the alias, with the address left as they typed it. Only
-- aliases read it; a primary is always its own address.

ALTER TABLE pages.slugs
  ADD COLUMN is_redirect boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN pages.slugs.is_redirect IS
  'Aliases only: true sends a 308 to the primary, false serves the page at this name.';
COMMENT ON COLUMN pages.slugs.role IS
  'primary: the page''s address. alias: another name for it, which redirects (308) to the primary unless is_redirect is false.';

-- migrate:down

COMMENT ON COLUMN pages.slugs.role IS 'primary: the page''s address. alias: redirects (308) to the primary.';
ALTER TABLE pages.slugs DROP COLUMN is_redirect;
