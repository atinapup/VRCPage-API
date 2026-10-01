-- migrate:up

-- How a page looks, chosen by its owner: its own accent colour, and a banner
-- of its own for when VRChat has none.

ALTER TABLE pages.pages
  ADD COLUMN accent text CHECK (accent ~ '^#[0-9a-f]{6}$'),
  ADD COLUMN banner_image_id uuid REFERENCES vrchat.images ON DELETE RESTRICT;
COMMENT ON COLUMN pages.pages.accent IS 'The page''s accent colour, #rrggbb. NULL: vrc.page''s own.';
COMMENT ON COLUMN pages.pages.banner_image_id IS 'A banner uploaded on vrc.page, shown only while VRChat has none.';
CREATE INDEX ON pages.pages (banner_image_id) WHERE banner_image_id IS NOT NULL;

-- An uploaded banner has no VRChat address to remember.
ALTER TABLE vrchat.images ALTER COLUMN source_url DROP NOT NULL;
COMMENT ON COLUMN vrchat.images.source_url IS
  'The address VRChat gave for this picture most recently. A refresh that sees it again downloads nothing. NULL for a banner uploaded on vrc.page.';
COMMENT ON TABLE vrchat.images IS
  'Our WebP copies of VRChat icons and banners, and banners uploaded on vrc.page, deduplicated by hash and served at /images/<sha256 hex>.webp. A row goes as soon as nothing uses it.';

-- The clean-up now also knows about pages' own banners, and is fired by
-- pages as well. Which columns OLD has depends on the table that fired it.
CREATE OR REPLACE FUNCTION internal.drop_unused_images() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  candidates uuid[];
BEGIN
  IF TG_TABLE_SCHEMA = 'pages' THEN
    candidates := ARRAY[OLD.banner_image_id];
  ELSE
    candidates := ARRAY[OLD.icon_image_id, OLD.banner_image_id];
  END IF;
  BEGIN
    DELETE FROM vrchat.images i
     WHERE i.id = ANY (candidates)
       AND NOT EXISTS (SELECT 1 FROM vrchat.users u WHERE u.icon_image_id = i.id OR u.banner_image_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM vrchat.groups g WHERE g.icon_image_id = i.id OR g.banner_image_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM pages.pages p WHERE p.banner_image_id = i.id);
  EXCEPTION WHEN foreign_key_violation THEN
    -- Someone else attached the same picture while this ran, so it is in use
    -- after all. Nothing to clean up, and no reason to fail their change.
    NULL;
  END;
  RETURN NULL;
END;
$$;

CREATE TRIGGER drop_unused_images AFTER DELETE OR UPDATE OF banner_image_id ON pages.pages
  FOR EACH ROW EXECUTE FUNCTION internal.drop_unused_images();

-- migrate:down

DROP TRIGGER drop_unused_images ON pages.pages;
CREATE OR REPLACE FUNCTION internal.drop_unused_images() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  BEGIN
    DELETE FROM vrchat.images i
     WHERE i.id IN (OLD.icon_image_id, OLD.banner_image_id)
       AND NOT EXISTS (SELECT 1 FROM vrchat.users u WHERE u.icon_image_id = i.id OR u.banner_image_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM vrchat.groups g WHERE g.icon_image_id = i.id OR g.banner_image_id = i.id);
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
  RETURN NULL;
END;
$$;
COMMENT ON TABLE vrchat.images IS
  'Our WebP copies of VRChat icons and banners, deduplicated by hash and served at /images/<sha256 hex>.webp. A row goes as soon as no user or group uses it.';
COMMENT ON COLUMN vrchat.images.source_url IS 'The address VRChat gave for this picture most recently. A refresh that sees it again downloads nothing.';
ALTER TABLE vrchat.images ALTER COLUMN source_url SET NOT NULL;
ALTER TABLE pages.pages DROP COLUMN banner_image_id, DROP COLUMN accent;
