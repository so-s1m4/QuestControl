-- Migration 034: Scope canonical VR headset base stations by room_id

ALTER TABLE camera_headset_zones ADD COLUMN IF NOT EXISTS room_id uuid REFERENCES rooms(id) ON DELETE CASCADE;

UPDATE camera_headset_zones z
SET room_id = c.room_id
FROM cameras c
WHERE z.camera_id = c.id AND z.room_id IS NULL;

-- Disallow canonical base on orphan cameras without a room
UPDATE camera_headset_zones
SET is_canonical_base = false
WHERE room_id IS NULL AND is_canonical_base = true;

DROP INDEX IF EXISTS camera_headset_zones_canonical_idx;

CREATE UNIQUE INDEX IF NOT EXISTS camera_headset_zones_room_canonical_idx
  ON camera_headset_zones(room_id, base_station_id)
  WHERE is_canonical_base = true AND room_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_canonical_base_room'
  ) THEN
    ALTER TABLE camera_headset_zones
      ADD CONSTRAINT chk_canonical_base_room
      CHECK (is_canonical_base = false OR room_id IS NOT NULL);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION sync_camera_room_to_zones()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.room_id IS DISTINCT FROM NEW.room_id) THEN
    IF NEW.room_id IS NULL THEN
      UPDATE camera_headset_zones
      SET room_id = NULL,
          is_canonical_base = false
      WHERE camera_id = NEW.id;
    ELSE
      UPDATE camera_headset_zones
      SET room_id = NEW.room_id
      WHERE camera_id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_camera_room_to_zones ON cameras;
CREATE TRIGGER trg_sync_camera_room_to_zones
AFTER UPDATE OF room_id ON cameras
FOR EACH ROW
EXECUTE FUNCTION sync_camera_room_to_zones();
