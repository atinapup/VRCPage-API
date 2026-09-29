-- migrate:up

-- The VRChat session the API signed in with, kept so a restart or a second
-- API process reuses it instead of signing in again. VRChat limits how many
-- sessions an account can open, and one that keeps opening them gets locked
-- out, so a sign-in only happens when there is no cookie here or VRChat has
-- just refused the one there is.
--
-- It is as good as the account's password for as long as it lasts, so the
-- readonly role loses the whole-table grant and gets every other column back.

ALTER TABLE vrchat.client_state
  ADD COLUMN auth_cookie text CHECK (char_length(auth_cookie) BETWEEN 1 AND 1000);

COMMENT ON COLUMN vrchat.client_state.auth_cookie IS
  'The value of VRChat''s auth cookie for the service account. NULL means the next read signs in first.';

REVOKE SELECT ON vrchat.client_state FROM vrcpage_readonly;
GRANT SELECT (id, next_call_at, backoff_seconds, backoff_until, consecutive_auth_failures, circuit_opened_at, circuit_reason, updated_at)
  ON vrchat.client_state TO vrcpage_readonly;

-- migrate:down

REVOKE SELECT (id, next_call_at, backoff_seconds, backoff_until, consecutive_auth_failures, circuit_opened_at, circuit_reason, updated_at)
  ON vrchat.client_state FROM vrcpage_readonly;
GRANT SELECT ON vrchat.client_state TO vrcpage_readonly;
ALTER TABLE vrchat.client_state DROP COLUMN auth_cookie;
