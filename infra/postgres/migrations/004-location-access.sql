ALTER TABLE locations ADD COLUMN IF NOT EXISTS external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS locations_external_id_idx ON locations(external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS user_locations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,location_id)
);
UPDATE roles SET permissions='["bookings:read","rooms:read","locations:read","sessions:*","devices:read","devices:command","cameras:read","local_sites:open"]'::jsonb WHERE name='OPERATOR';
