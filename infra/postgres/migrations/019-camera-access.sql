INSERT INTO roles(name,permissions)
VALUES ('CAMERA_VIEWER','["cameras:read","locations:read"]'::jsonb)
ON CONFLICT(name) DO UPDATE SET permissions=excluded.permissions;

CREATE TABLE IF NOT EXISTS user_cameras (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,camera_id)
);
