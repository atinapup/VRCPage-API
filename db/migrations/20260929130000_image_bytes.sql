-- migrate:up

-- Our copies of VRChat icons and banners live in the database itself, not in
-- a bucket: one place to back up, nothing extra to run, and deleting a person
-- deletes their pictures in the same transaction.
--
-- Each is re-encoded to WebP by the API before it is stored, so the bytes are
-- small and always the same format. They are served at
-- <website>/images/<sha256 hex>.webp, which the website passes to the API.
--
-- source_url is the address VRChat gave for it. A refresh that finds the same
-- address again reuses the row instead of downloading the picture again.

ALTER TABLE vrchat.images
  ADD COLUMN bytes bytea NOT NULL CHECK (octet_length(bytes) = byte_size),
  ADD COLUMN source_url text NOT NULL CHECK (char_length(source_url) BETWEEN 1 AND 2000);

-- WebP is already compressed; don't spend time trying again.
ALTER TABLE vrchat.images ALTER COLUMN bytes SET STORAGE EXTERNAL;
CREATE INDEX ON vrchat.images (source_url);

COMMENT ON TABLE vrchat.images IS
  'Our WebP copies of VRChat icons and banners, deduplicated by hash and served at /images/<sha256 hex>.webp. A row goes as soon as no user or group uses it.';
COMMENT ON COLUMN vrchat.images.source_url IS 'The address VRChat gave for this picture most recently. A refresh that sees it again downloads nothing.';

-- Two users uploading the same picture share one row; the second address wins.
GRANT UPDATE (source_url) ON vrchat.images TO vrcpage_api;

-- An image goes when its last user does. Users and groups keep RESTRICT on
-- their references, so nothing can delete a picture still on a page; this
-- trigger is what deletes the ones that aren't.
--
-- It runs after a user or group is deleted (by hand, by a disconnect, an
-- unclaim, or an account's deletion cascading) and after either picture
-- changes. SECURITY DEFINER because a cascade from auth.accounts arrives as
-- whichever login deleted the account.
CREATE FUNCTION internal.drop_unused_images() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  BEGIN
    DELETE FROM vrchat.images i
     WHERE i.id IN (OLD.icon_image_id, OLD.banner_image_id)
       AND NOT EXISTS (SELECT 1 FROM vrchat.users u WHERE u.icon_image_id = i.id OR u.banner_image_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM vrchat.groups g WHERE g.icon_image_id = i.id OR g.banner_image_id = i.id);
  EXCEPTION WHEN foreign_key_violation THEN
    -- Someone else attached the same picture while this ran, so it is in use
    -- after all. Nothing to clean up, and no reason to fail their deletion.
    NULL;
  END;
  RETURN NULL;
END;
$$;

CREATE TRIGGER drop_unused_images AFTER DELETE OR UPDATE OF icon_image_id, banner_image_id ON vrchat.users
  FOR EACH ROW EXECUTE FUNCTION internal.drop_unused_images();
CREATE TRIGGER drop_unused_images AFTER DELETE OR UPDATE OF icon_image_id, banner_image_id ON vrchat.groups
  FOR EACH ROW EXECUTE FUNCTION internal.drop_unused_images();

-- migrate:down

DROP TRIGGER drop_unused_images ON vrchat.groups;
DROP TRIGGER drop_unused_images ON vrchat.users;
DROP FUNCTION internal.drop_unused_images();
REVOKE UPDATE (source_url) ON vrchat.images FROM vrcpage_api;
COMMENT ON TABLE vrchat.images IS 'Our R2 copies of VRChat icons and banners, deduplicated by hash. R2 keys are images/<sha256 hex>.webp|avif.';
ALTER TABLE vrchat.images DROP COLUMN source_url, DROP COLUMN bytes;
