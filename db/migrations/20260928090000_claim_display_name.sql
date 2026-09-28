-- migrate:up

-- The name of whatever is being claimed, kept from the one read that issued
-- the code.
--
-- Without it, reopening a claim had to read VRChat again just to say "you are
-- claiming Night Market". With the real client that is a call from the
-- 1440-a-day budget every time a page loads, spent on a name that has not
-- changed. It is stored once and read from here afterwards.

ALTER TABLE vrchat.claim_codes
  ADD COLUMN display_name text CHECK (char_length(display_name) BETWEEN 1 AND 200);

COMMENT ON COLUMN vrchat.claim_codes.display_name IS
  'The VRChat display name or group name, as it read when the code was issued. Saves a call when the claim is reopened.';

-- migrate:down

ALTER TABLE vrchat.claim_codes DROP COLUMN display_name;
