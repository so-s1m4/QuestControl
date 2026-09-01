CREATE TABLE IF NOT EXISTS camera_shares(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text UNIQUE NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL,
  revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS camera_share_cameras(
  share_id uuid NOT NULL REFERENCES camera_shares(id) ON DELETE CASCADE,
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  PRIMARY KEY(share_id,camera_id)
);
