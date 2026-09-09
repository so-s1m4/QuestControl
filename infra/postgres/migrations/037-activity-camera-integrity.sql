-- Existing installations may have applied migration 036 while camera_id was
-- text.  Camera IDs in QuestControl are UUIDs; convert before adding the FK so
-- orphaned activity records cannot survive a camera deletion.
ALTER TABLE activity_events
  ALTER COLUMN camera_id TYPE uuid USING camera_id::uuid;

ALTER TABLE activity_dataset_samples
  ALTER COLUMN camera_id TYPE uuid USING camera_id::uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_events_camera_id_fkey') THEN
    ALTER TABLE activity_events
      ADD CONSTRAINT activity_events_camera_id_fkey
      FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_dataset_samples_camera_id_fkey') THEN
    ALTER TABLE activity_dataset_samples
      ADD CONSTRAINT activity_dataset_samples_camera_id_fkey
      FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE;
  END IF;
END $$;
