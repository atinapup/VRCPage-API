-- migrate:up

-- The single queue for every VRChat request. It needs pages.pages, so it
-- comes after the pages migration.

CREATE TYPE vrchat.job_kind AS ENUM ('user_refresh', 'group_refresh', 'claim_check');
CREATE TYPE vrchat.job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

CREATE TABLE vrchat.jobs (
  id uuid PRIMARY KEY DEFAULT internal.uuidv7(),
  kind vrchat.job_kind NOT NULL,
  lane vrchat.lane NOT NULL,
  page_id uuid REFERENCES pages.pages ON DELETE CASCADE,
  claim_code_id uuid REFERENCES vrchat.claim_codes ON DELETE CASCADE,
  requested_by uuid REFERENCES auth.accounts ON DELETE SET NULL,
  status vrchat.job_status NOT NULL DEFAULT 'queued',
  priority smallint NOT NULL DEFAULT 100,
  run_after timestamptz NOT NULL DEFAULT now(),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  started_at timestamptz,
  finished_at timestamptz,
  error text CHECK (char_length(error) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_target_check CHECK (
    (kind = 'claim_check' AND claim_code_id IS NOT NULL AND page_id IS NULL)
    OR (kind <> 'claim_check' AND page_id IS NOT NULL AND claim_code_id IS NULL)
  ),
  CONSTRAINT jobs_finished_check CHECK ((status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);
COMMENT ON TABLE vrchat.jobs IS 'Queue of VRChat reads (refreshes and claim checks), drained one at a time with FOR UPDATE SKIP LOCKED.';
COMMENT ON COLUMN vrchat.jobs.priority IS 'Lower runs first.';
COMMENT ON COLUMN vrchat.jobs.requested_by IS 'The account that pressed refresh or check. Also answers the manual daily cap.';

CREATE UNIQUE INDEX jobs_one_open_per_page_idx ON vrchat.jobs (page_id) WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX jobs_one_open_per_claim_idx ON vrchat.jobs (claim_code_id) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_queue_idx ON vrchat.jobs (priority, run_after, id) WHERE status = 'queued';
CREATE INDEX ON vrchat.jobs (requested_by, created_at) WHERE lane = 'manual';
CREATE INDEX ON vrchat.jobs (page_id, created_at) WHERE lane = 'manual';
CREATE INDEX ON vrchat.jobs (finished_at) WHERE finished_at IS NOT NULL;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON vrchat.jobs
  FOR EACH ROW EXECUTE FUNCTION internal.set_updated_at();

GRANT SELECT, INSERT, UPDATE ON vrchat.jobs TO vrcpage_api;
GRANT SELECT ON vrchat.jobs TO vrcpage_readonly;

-- migrate:down

DROP TABLE vrchat.jobs;
DROP TYPE vrchat.job_status;
DROP TYPE vrchat.job_kind;
