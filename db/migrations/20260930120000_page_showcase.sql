-- migrate:up

-- The pages an admin picked as the example on vrc.page's home page. Several
-- may be picked; each visit shows one of them at random. Only public user
-- pages are ever shown, so an unlisted page's address is never published.

ALTER TABLE pages.pages
  ADD COLUMN is_showcase boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pages.pages.is_showcase IS
  'Picked by an admin as the home page example. Shown only while the page is a public, visible user page.';

-- migrate:down

ALTER TABLE pages.pages DROP COLUMN is_showcase;
