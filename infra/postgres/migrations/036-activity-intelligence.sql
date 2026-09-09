-- Migration 036: Activity Intelligence & Behavioral Action Detection

CREATE TABLE IF NOT EXISTS activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  preset_name text,
  track_id integer,
  action_type text NOT NULL,
  sub_type text,
  status text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'DISMISSED', 'INVESTIGATING', 'RESOLVED')),
  confidence numeric(5,4) NOT NULL DEFAULT 1.0,
  reason text,
  evidence jsonb NOT NULL DEFAULT '{}',
  snapshot_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by text
);

CREATE INDEX IF NOT EXISTS activity_events_room_idx ON activity_events(room_id, created_at DESC) WHERE room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_events_location_idx ON activity_events(location_id, created_at DESC) WHERE location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_events_camera_idx ON activity_events(camera_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_events_action_idx ON activity_events(action_type, status, created_at DESC);

CREATE TABLE IF NOT EXISTS activity_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid REFERENCES rooms(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{"windowSec": 1.5, "minReversals": 3, "minConfidence": 0.60, "personCooldownSec": 30, "roomCooldownSec": 60, "telegramAlerts": true}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(room_id, action_type)
);

CREATE INDEX IF NOT EXISTS activity_settings_room_idx ON activity_settings(room_id);

CREATE TABLE IF NOT EXISTS activity_dataset_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  label text NOT NULL DEFAULT 'POSITIVE',
  verification_status text NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_status IN ('UNVERIFIED', 'VERIFIED', 'REJECTED')),
  video_clip_path text,
  duration_sec numeric(6,2),
  keypoints_data jsonb NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  operator_id text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activity_samples_action_idx ON activity_dataset_samples(action_type, verification_status);
CREATE INDEX IF NOT EXISTS activity_samples_room_idx ON activity_dataset_samples(room_id);

CREATE TABLE IF NOT EXISTS activity_model_releases (
  release_id text PRIMARY KEY,
  action_type text NOT NULL,
  model_version text NOT NULL,
  sha256 text NOT NULL,
  manifest_hash text,
  quality_gate_metrics jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'INACTIVE' CHECK (status IN ('TRAINING', 'ACTIVE', 'INACTIVE', 'ARCHIVED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
