ALTER TABLE cameras ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES locations(id) ON DELETE SET NULL;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS plan_x numeric(6,3);
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS plan_y numeric(6,3);
UPDATE cameras c SET location_id=r.location_id FROM rooms r WHERE c.room_id=r.id AND c.location_id IS NULL;

CREATE TABLE IF NOT EXISTS location_plans (
  location_id uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  background_image text,
  background_mode text NOT NULL DEFAULT 'CONTAIN',
  background_scale numeric(6,2) NOT NULL DEFAULT 100,
  background_x numeric(6,2) NOT NULL DEFAULT 50,
  background_y numeric(6,2) NOT NULL DEFAULT 50,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE location_plans ADD COLUMN IF NOT EXISTS background_mode text NOT NULL DEFAULT 'CONTAIN';
ALTER TABLE location_plans ADD COLUMN IF NOT EXISTS background_scale numeric(6,2) NOT NULL DEFAULT 100;
ALTER TABLE location_plans ADD COLUMN IF NOT EXISTS background_x numeric(6,2) NOT NULL DEFAULT 50;
ALTER TABLE location_plans ADD COLUMN IF NOT EXISTS background_y numeric(6,2) NOT NULL DEFAULT 50;

CREATE TABLE IF NOT EXISTS plan_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  room_id uuid REFERENCES rooms(id) ON DELETE SET NULL,
  name text NOT NULL,
  type text NOT NULL,
  color text NOT NULL DEFAULT '#64748b',
  x numeric(6,3) NOT NULL,
  y numeric(6,3) NOT NULL,
  width numeric(6,3) NOT NULL,
  height numeric(6,3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS plan_zone_id uuid REFERENCES plan_zones(id) ON DELETE SET NULL;
