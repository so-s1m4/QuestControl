ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_users_not_deleted ON users(created_at DESC) WHERE deleted_at IS NULL;
