CREATE TABLE IF NOT EXISTS people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_token bytea NOT NULL,
  identity_type text NOT NULL DEFAULT 'EMAIL_HMAC'
    CHECK (identity_type IN ('EMAIL_HMAC', 'BOOKING_RANDOM')),
  token_version smallint NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(token_version, identity_token)
);
ALTER TABLE people ADD COLUMN IF NOT EXISTS identity_type text NOT NULL DEFAULT 'EMAIL_HMAC';

CREATE TABLE IF NOT EXISTS booking_participants (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  participant_role text NOT NULL DEFAULT 'PLAYER'
    CHECK (participant_role IN ('OWNER', 'PLAYER')),
  category_at_booking text,
  age_band_at_booking text,
  snapshot jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(booking_id, person_id)
);

CREATE TABLE IF NOT EXISTS session_participants (
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  participant_role text NOT NULL DEFAULT 'PLAYER'
    CHECK (participant_role IN ('OWNER', 'PLAYER')),
  category_at_play text,
  age_band_at_play text,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id, person_id)
);

CREATE INDEX IF NOT EXISTS booking_participants_person_idx
  ON booking_participants(person_id, booking_id);
CREATE INDEX IF NOT EXISTS session_participants_person_idx
  ON session_participants(person_id, session_id);
CREATE INDEX IF NOT EXISTS sessions_started_at_idx
  ON sessions(started_at DESC);

UPDATE roles
SET permissions = permissions || '["statistics:read"]'::jsonb
WHERE name IN ('ADMIN', 'OWNER')
  AND NOT permissions ? 'statistics:read';
