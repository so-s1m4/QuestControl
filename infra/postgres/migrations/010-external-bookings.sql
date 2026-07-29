ALTER TABLE bookings ADD COLUMN IF NOT EXISTS external_source text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS external_id text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS product_name text;

CREATE UNIQUE INDEX IF NOT EXISTS bookings_external_identity_idx
  ON bookings(external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
