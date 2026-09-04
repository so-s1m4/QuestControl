CREATE TABLE IF NOT EXISTS work_time_entries(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  arrived_at timestamptz NOT NULL,
  left_at timestamptz NOT NULL,
  note text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(left_at > arrived_at)
);
CREATE INDEX IF NOT EXISTS work_time_entries_arrived_idx ON work_time_entries(arrived_at DESC);
CREATE INDEX IF NOT EXISTS work_time_entries_user_arrived_idx ON work_time_entries(user_id,arrived_at DESC);
