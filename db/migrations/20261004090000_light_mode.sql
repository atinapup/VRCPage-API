-- migrate:up

-- Light mode in Settings, Accessibility: vrc.page in light colours,
-- kept with the account like the other two display settings.
ALTER TABLE auth.account_preferences
  ADD COLUMN light_mode boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN auth.account_preferences.light_mode IS 'Light colours instead of dark (light mode on the website).';

-- migrate:down

ALTER TABLE auth.account_preferences DROP COLUMN light_mode;
