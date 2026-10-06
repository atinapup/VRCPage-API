-- migrate:up

-- Which visitor opened a link, or left: the same hash as their view in
-- pages.views, so the admin logs can follow one visitor from a page to the
-- links they opened. A vrc.page/<name>/<platform> redirect has a click and
-- no view, and this is the only way to say whose click it was.
ALTER TABLE pages.visit_events ADD COLUMN visitor_hash internal.sha256;
COMMENT ON COLUMN pages.visit_events.visitor_hash IS 'Same as pages.views.visitor_hash: an HMAC of the address with a monthly key. Null on rows from before it was kept.';

-- migrate:down

ALTER TABLE pages.visit_events DROP COLUMN visitor_hash;
