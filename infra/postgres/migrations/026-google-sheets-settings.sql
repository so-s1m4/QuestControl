CREATE TABLE IF NOT EXISTS app_settings(
  key text PRIMARY KEY,
  encrypted_value bytea NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
