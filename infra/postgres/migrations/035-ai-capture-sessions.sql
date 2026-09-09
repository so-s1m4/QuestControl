-- Migration 035: Server-owned AI dataset capture sessions

CREATE TABLE IF NOT EXISTS ai_capture_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
  notes text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE INDEX IF NOT EXISTS ai_capture_sessions_room_cam_status_idx
  ON ai_capture_sessions(room_id, camera_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS ai_capture_sessions_active_room_cam_uidx
  ON ai_capture_sessions(room_id, camera_id) WHERE status = 'ACTIVE';
