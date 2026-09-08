-- Migration 032: Camera AI Video Intelligence

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS ai_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS tracking_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS analysis_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS camera_ai_states (
  camera_id uuid PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  people_count integer NOT NULL DEFAULT 0,
  occupied boolean NOT NULL DEFAULT false,
  motion boolean NOT NULL DEFAULT false,
  last_person_entered timestamptz,
  last_person_left timestamptz,
  last_activity timestamptz NOT NULL DEFAULT now(),
  last_updated timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS camera_ai_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  type text NOT NULL,
  timestamp timestamptz NOT NULL DEFAULT now(),
  people_count integer NOT NULL DEFAULT 0,
  confidence numeric(5,4) NOT NULL DEFAULT 1.0,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS camera_ai_events_camera_idx ON camera_ai_events(camera_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS camera_ai_events_room_idx ON camera_ai_events(room_id, timestamp DESC) WHERE room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS camera_ai_events_type_idx ON camera_ai_events(type, timestamp DESC);

CREATE TABLE IF NOT EXISTS camera_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  name text NOT NULL,
  ptz_preset text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(camera_id, name)
);

CREATE INDEX IF NOT EXISTS camera_presets_camera_idx ON camera_presets(camera_id);
