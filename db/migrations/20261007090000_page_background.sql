-- migrate:up

-- A background of the page's own, uploaded on vrc.page and drawn behind the
-- whole page, and how strongly: 0 to 100 percent opaque. 25 by default, so
-- a background sits back behind the card rather than competing with it.

ALTER TABLE pages.pages
  ADD COLUMN background_image_id uuid REFERENCES vrchat.images ON DELETE RESTRICT,
  ADD COLUMN background_opacity smallint NOT NULL DEFAULT 25
    CHECK (background_opacity BETWEEN 0 AND 100);
COMMENT ON COLUMN pages.pages.background_image_id IS 'A background uploaded on vrc.page, drawn behind the whole page.';
COMMENT ON COLUMN pages.pages.background_opacity IS 'How opaque the background is, in percent.';
CREATE INDEX ON pages.pages (background_image_id) WHERE background_image_id IS NOT NULL;

COMMENT ON TABLE vrchat.images IS
  'Our WebP copies of VRChat icons and banners, and pictures, banners and backgrounds uploaded on vrc.page, deduplicated by hash and served at /images/<sha256 hex>.webp. A row goes as soon as nothing uses it.';
COMMENT ON COLUMN vrchat.images.source_url IS
  'The address VRChat gave for this picture most recently. A refresh that sees it again downloads nothing. NULL for a picture, banner or background uploaded on vrc.page.';

-- The clean-up also knows about pages' own backgrounds.
CREATE OR REPLACE FUNCTION internal.drop_unused_images() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  candidates uuid[];
BEGIN
  IF TG_TABLE_SCHEMA = 'pages' THEN
    candidates := ARRAY[OLD.banner_image_id, OLD.picture_image_id, OLD.background_image_id];
  ELSE
    candidates := ARRAY[OLD.icon_image_id, OLD.banner_image_id];
  END IF;
  BEGIN
    DELETE FROM vrchat.images i
     WHERE i.id = ANY (candidates)
       AND NOT EXISTS (SELECT 1 FROM vrchat.users u WHERE u.icon_image_id = i.id OR u.banner_image_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM vrchat.groups g WHERE g.icon_image_id = i.id OR g.banner_image_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM pages.pages p WHERE p.banner_image_id = i.id OR p.picture_image_id = i.id OR p.background_image_id = i.id);
  EXCEPTION WHEN foreign_key_violation THEN
    -- Someone else attached the same picture while this ran, so it is in use
    -- after all. Nothing to clean up, and no reason to fail their change.
    NULL;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER drop_unused_images ON pages.pages;
CREATE TRIGGER drop_unused_images AFTER DELETE OR UPDATE OF banner_image_id, picture_image_id, background_image_id ON pages.pages
  FOR EACH ROW EXECUTE FUNCTION internal.drop_unused_images();

-- migrate:down

-- Taken off first, while the clean-up still knows about them, so their
-- images go with them.
UPDATE pages.pages SET background_image_id = NULL WHERE background_image_id IS NOT NULL;
DROP TRIGGER drop_unused_images ON pages.pages;
CREATE OR REPLACE FUNCTION internal.drop_unused_images() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  candidates uuid[];
BEGIN
  IF TG_TABLE_SCHEMA = 'pages' THEN
    candidates := ARRAY[OLD.banner_image_id, OLD.picture_image_id];
  ELSE
    candidates := ARRAY[OLD.icon_image_id, OLD.banner_image_id];
  END IF;
  BEGIN
    DELETE FROM vrchat.images i
     WHERE i.id = ANY (candidates)
       AND NOT EXISTS (SELECT 1 FROM vrchat.users u WHERE u.icon_image_id = i.id OR u.banner_image_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM vrchat.groups g WHERE g.icon_image_id = i.id OR g.banner_image_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM pages.pages p WHERE p.banner_image_id = i.id OR p.picture_image_id = i.id);
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
  RETURN NULL;
END;
$$;
CREATE TRIGGER drop_unused_images AFTER DELETE OR UPDATE OF banner_image_id, picture_image_id ON pages.pages
  FOR EACH ROW EXECUTE FUNCTION internal.drop_unused_images();
ALTER TABLE pages.pages DROP COLUMN background_opacity, DROP COLUMN background_image_id;
COMMENT ON TABLE vrchat.images IS
  'Our WebP copies of VRChat icons and banners, and pictures and banners uploaded on vrc.page, deduplicated by hash and served at /images/<sha256 hex>.webp. A row goes as soon as nothing uses it.';
COMMENT ON COLUMN vrchat.images.source_url IS
  'The address VRChat gave for this picture most recently. A refresh that sees it again downloads nothing. NULL for a picture or banner uploaded on vrc.page.';
