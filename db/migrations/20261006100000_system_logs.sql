-- migrate:up

-- The admin logs read audit.events newest first, over a time range, often
-- with no other filter; the other indexes all lead with something else.
CREATE INDEX ON audit.events (occurred_at DESC);

-- Every event now keeps the address and browser of whoever acted, not only
-- security events. Anonymous page views never come here.
COMMENT ON COLUMN audit.events.ip IS 'IP of whoever acted, on every event, for the admin logs. Security events are kept longer (retention).';
COMMENT ON COLUMN audit.events.user_agent IS 'Browser of whoever acted, on every event.';

-- migrate:down

COMMENT ON COLUMN audit.events.user_agent IS NULL;
COMMENT ON COLUMN audit.events.ip IS 'Full IP, written for security events only (spec section 14).';
DROP INDEX audit.events_occurred_at_idx;
