-- migrate:up

-- Page names are lowercase, so an address is always written one way. The
-- display name is VRChat's and keeps its capitals; only the address loses
-- them. slug_key already held the lowercase name, so nothing can collide.

UPDATE pages.slugs SET slug = slug_key WHERE slug <> slug_key;

ALTER TABLE pages.slugs DROP CONSTRAINT slugs_slug_format_check;
ALTER TABLE pages.slugs
  ADD CONSTRAINT slugs_slug_format_check CHECK (slug ~ '^[a-z0-9_-]{1,64}$');

COMMENT ON COLUMN pages.slugs.slug IS 'The name, lowercase. The same as slug_key.';

-- migrate:down

-- The capitals the names had are gone; this only lets new ones in again.
ALTER TABLE pages.slugs DROP CONSTRAINT slugs_slug_format_check;
ALTER TABLE pages.slugs
  ADD CONSTRAINT slugs_slug_format_check CHECK (slug ~ '^[A-Za-z0-9_-]{1,64}$');

COMMENT ON COLUMN pages.slugs.slug IS 'The name as typed, which is how it is shown.';
