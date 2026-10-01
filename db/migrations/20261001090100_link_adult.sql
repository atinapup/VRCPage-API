-- migrate:up

-- A link its owner marked as for adults. Visitors confirm before it opens.
-- The website also treats every OnlyFans and Fansly link as 18+, whatever
-- this says, so a VRChat bio link there needs no row of its own.

ALTER TABLE pages.links
  ADD COLUMN is_adult boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pages.links.is_adult IS
  'Marked 18+ by the page''s owner or an editor. Visitors confirm before it opens.';

-- migrate:down

ALTER TABLE pages.links DROP COLUMN is_adult;
