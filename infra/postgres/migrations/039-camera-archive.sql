ALTER TABLE cameras ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS cameras_active_idx ON cameras(id) WHERE archived_at IS NULL;
