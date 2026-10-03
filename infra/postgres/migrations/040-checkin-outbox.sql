-- Keep booking links usable independently of the app's upcoming-visit window.
CREATE TABLE IF NOT EXISTS checkin_reservations (
  club_id text NOT NULL,
  booking_id text NOT NULL,
  encrypted_snapshot bytea NOT NULL,
  encrypted_documents bytea,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, booking_id)
);

-- Persist before contacting Time to Grow. Completed rows retain only the
-- fingerprint and delivery metadata so browser retries remain idempotent.
CREATE TABLE IF NOT EXISTS checkin_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id text NOT NULL,
  booking_id text NOT NULL,
  fingerprint text NOT NULL,
  encrypted_payload bytea,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  participant_id text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, booking_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS checkin_submissions_pending_idx
  ON checkin_submissions (next_attempt_at) WHERE completed_at IS NULL;
