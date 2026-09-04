CREATE TABLE IF NOT EXISTS session_inventory_deductions(
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES inventory_items(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK(quantity>0),
  PRIMARY KEY(session_id,item_id)
);
