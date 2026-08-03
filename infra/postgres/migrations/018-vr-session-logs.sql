CREATE TABLE IF NOT EXISTS vr_session_logs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  external_session_id text,
  game_name text NOT NULL DEFAULT 'Неизвестная игра',
  stations text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','FINISHED','INTERRUPTED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  duration_seconds integer,
  started_by uuid REFERENCES users(id) ON DELETE SET NULL,
  raw_start jsonb NOT NULL DEFAULT '{}',
  raw_end jsonb NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS vr_session_logs_external_idx
  ON vr_session_logs(location_id,external_session_id)
  WHERE external_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vr_session_logs_started_idx ON vr_session_logs(location_id,started_at DESC);
