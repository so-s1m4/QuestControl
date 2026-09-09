-- Migration 033: Local AI VR Headset Inventory & Multi-Preset Tracking

ALTER TABLE cameras ADD COLUMN IF NOT EXISTS headset_tracking_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS camera_headset_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  preset_name text NOT NULL DEFAULT 'default',
  name text NOT NULL,
  zone_type text NOT NULL DEFAULT 'WORK_ZONE',
  headset_id text,
  x double precision NOT NULL DEFAULT 0,
  y double precision NOT NULL DEFAULT 0,
  width double precision NOT NULL DEFAULT 0.1,
  height double precision NOT NULL DEFAULT 0.1,
  polygon jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS camera_headset_zones_cam_preset_idx ON camera_headset_zones(camera_id, preset_name);

CREATE TABLE IF NOT EXISTS camera_headset_states (
  camera_id uuid PRIMARY KEY REFERENCES cameras(id) ON DELETE CASCADE,
  current_preset text NOT NULL DEFAULT 'default',
  charging_base_count integer NOT NULL DEFAULT 0,
  outside_zone_count integer NOT NULL DEFAULT 0,
  not_on_base_count integer NOT NULL DEFAULT 0,
  not_on_base_headsets jsonb NOT NULL DEFAULT '[]',
  total_detected integer NOT NULL DEFAULT 0,
  assigned_zones_state jsonb NOT NULL DEFAULT '{}',
  empty_assigned_zones jsonb NOT NULL DEFAULT '[]',
  not_visible_zones jsonb NOT NULL DEFAULT '[]',
  confidence double precision NOT NULL DEFAULT 1.0,
  model_status text NOT NULL DEFAULT 'READY',
  last_event_type text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE camera_headset_states ADD COLUMN IF NOT EXISTS not_on_base_count integer NOT NULL DEFAULT 0;
ALTER TABLE camera_headset_states ADD COLUMN IF NOT EXISTS not_on_base_headsets jsonb NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS camera_headset_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  preset_name text,
  event_type text NOT NULL,
  headset_id text,
  zone_id uuid REFERENCES camera_headset_zones(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  timestamp timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS camera_headset_events_cam_idx ON camera_headset_events(camera_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS camera_headset_events_room_idx ON camera_headset_events(room_id, timestamp DESC) WHERE room_id IS NOT NULL;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS expected_headset_count integer DEFAULT NULL;
ALTER TABLE camera_headset_zones ADD COLUMN IF NOT EXISTS base_station_id text DEFAULT 'default';
ALTER TABLE camera_headset_zones ADD COLUMN IF NOT EXISTS is_canonical_base boolean NOT NULL DEFAULT false;
ALTER TABLE camera_headset_zones ADD COLUMN IF NOT EXISTS expected_headset_count integer DEFAULT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS camera_headset_zones_canonical_idx ON camera_headset_zones(base_station_id) WHERE is_canonical_base = true;
ALTER TABLE camera_headset_states ADD COLUMN IF NOT EXISTS expected_headset_count integer DEFAULT NULL;
ALTER TABLE camera_headset_states ADD COLUMN IF NOT EXISTS missing_from_base_count integer DEFAULT 0;
ALTER TABLE camera_headset_states ADD COLUMN IF NOT EXISTS unlocated_count integer DEFAULT 0;
