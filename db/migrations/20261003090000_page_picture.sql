-- migrate:up

-- A picture of the page's own, uploaded on vrc.page, shown instead of the
-- VRChat icon. An uploaded banner now wins over VRChat's banner too: the
-- owner chose it, so it is what the page shows.

ALTER TABLE pages.pages
  ADD COLUMN picture_image_id uuid REFERENCES vrchat.images ON DELETE RESTRICT;
COMMENT ON COLUMN pages.pages.picture_image_id IS 'A picture uploaded on vrc.page, shown instead of the VRChat icon.';
COMMENT ON COLUMN pages.pages.banner_image_id IS 'A banner uploaded on vrc.page, shown instead of the VRChat banner.';
CREATE INDEX ON pages.pages (picture_image_id) WHERE picture_image_id IS NOT NULL;

COMMENT ON TABLE vrchat.images IS
  'Our WebP copies of VRChat icons and banners, and pictures and banners uploaded on vrc.page, deduplicated by hash and served at /images/<sha256 hex>.webp. A row goes as soon as nothing uses it.';
COMMENT ON COLUMN vrchat.images.source_url IS
  'The address VRChat gave for this picture most recently. A refresh that sees it again downloads nothing. NULL for a picture or banner uploaded on vrc.page.';

-- The clean-up also knows about pages' own pictures.
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
    -- Someone else attached the same picture while this ran, so it is in use
    -- after all. Nothing to clean up, and no reason to fail their change.
    NULL;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER drop_unused_images ON pages.pages;
CREATE TRIGGER drop_unused_images AFTER DELETE OR UPDATE OF banner_image_id, picture_image_id ON pages.pages
  FOR EACH ROW EXECUTE FUNCTION internal.drop_unused_images();

-- VRChat's profile endpoint only tells a profile's owner their status, so a
-- refresh reads it from GET /users/{userId} as well (src/vrchat/api.ts).
ALTER TYPE vrchat.endpoint ADD VALUE 'get_user_status';

-- migrate:down

-- An enum value can't be dropped in place; get_user_status stays, unused.
DROP TRIGGER drop_unused_images ON pages.pages;
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
    NULL;
  END;
  RETURN NULL;
END;
$$;
CREATE TRIGGER drop_unused_images AFTER DELETE OR UPDATE OF banner_image_id ON pages.pages
  FOR EACH ROW EXECUTE FUNCTION internal.drop_unused_images();
ALTER TABLE pages.pages DROP COLUMN picture_image_id;
COMMENT ON COLUMN pages.pages.banner_image_id IS 'A banner uploaded on vrc.page, shown only while VRChat has none.';
