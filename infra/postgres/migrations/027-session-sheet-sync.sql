ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sheet_sync_status text CHECK(sheet_sync_status IN ('PENDING','SYNCED','FAILED'));
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sheet_sync_error text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sheet_sync_payload jsonb;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sheet_synced_at timestamptz;
