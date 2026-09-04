ALTER TABLE sessions ADD COLUMN IF NOT EXISTS manual_player_count integer CHECK(manual_player_count>=0);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS game_id uuid REFERENCES games(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS inventory_items_game_idx ON inventory_items(game_id) WHERE is_active=true;
