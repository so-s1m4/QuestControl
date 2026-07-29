CREATE TABLE IF NOT EXISTS doorbell_calls(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  external_message_id text UNIQUE,
  status text NOT NULL DEFAULT 'RINGING' CHECK(status IN ('RINGING','ACKNOWLEDGED','EXPIRED')),
  raw_event jsonb NOT NULL DEFAULT '{}',
  rang_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS doorbell_calls_room_rang_idx ON doorbell_calls(room_id,rang_at DESC);
