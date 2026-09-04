ALTER TABLE bookings ADD COLUMN IF NOT EXISTS confirmed boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS external_booking_confirmations(
  club_id text NOT NULL,
  external_booking_id text NOT NULL,
  confirmed boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(club_id, external_booking_id)
);

CREATE TABLE IF NOT EXISTS work_shifts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  responsibility text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS work_shifts_starts_idx ON work_shifts(starts_at);
CREATE INDEX IF NOT EXISTS work_shifts_user_starts_idx ON work_shifts(user_id, starts_at);
