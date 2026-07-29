CREATE TABLE IF NOT EXISTS games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS games_room_name_idx ON games(room_id,lower(name));
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS game_id uuid REFERENCES games(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS game_id uuid REFERENCES games(id) ON DELETE SET NULL;

WITH relevant_locations AS (
  SELECT DISTINCT r.location_id
  FROM bookings b JOIN rooms r ON r.id=b.room_id
  WHERE b.external_source='TIME_TO_GROW'
)
INSERT INTO rooms(location_id,name,kind,capacity,status)
SELECT location_id,'VR','VR',1,'OFFLINE'
FROM relevant_locations l
WHERE NOT EXISTS (SELECT 1 FROM rooms r WHERE r.location_id=l.location_id AND lower(r.name)='vr');

WITH relevant_locations AS (
  SELECT DISTINCT r.location_id
  FROM bookings b JOIN rooms r ON r.id=b.room_id
  WHERE b.external_source='TIME_TO_GROW'
)
INSERT INTO rooms(location_id,name,kind,capacity,status)
SELECT location_id,'QuestBoxes','REAL',1,'OFFLINE'
FROM relevant_locations l
WHERE NOT EXISTS (SELECT 1 FROM rooms r WHERE r.location_id=l.location_id AND lower(r.name)='questboxes');

INSERT INTO games(room_id,name)
SELECT r.id,game.name
FROM rooms r
CROSS JOIN (VALUES ('Color Cube'),('Treasure Island'),('Star Wars')) AS game(name)
WHERE lower(r.name)='questboxes'
ON CONFLICT DO NOTHING;

INSERT INTO games(room_id,name)
SELECT DISTINCT target.id,b.product_name
FROM bookings b
JOIN rooms source ON source.id=b.room_id
JOIN rooms target ON target.location_id=source.location_id
WHERE b.external_source='TIME_TO_GROW'
  AND b.product_name IS NOT NULL
  AND lower(b.product_name) NOT IN (
    'friend pass','friendle pass','couple pass','general pass','kinder pass','kinder party'
  )
  AND lower(b.product_name) !~ 'krampus'
  AND lower(target.name)=CASE
    WHEN lower(b.product_name) IN ('color cube','call of cube','treasure island','star wars') THEN 'questboxes'
    ELSE 'vr'
  END
ON CONFLICT DO NOTHING;

INSERT INTO games(room_id,name)
SELECT r.id,'Krampus House'
FROM rooms r
WHERE lower(r.name) ~ 'krampus'
ON CONFLICT DO NOTHING;

UPDATE bookings b
SET room_id=target.id,
    game_id=CASE
      WHEN lower(b.product_name) IN (
        'friend pass','friendle pass','couple pass','general pass','kinder pass','kinder party'
      ) THEN NULL
      ELSE g.id
    END
FROM rooms source
JOIN rooms target ON target.location_id=source.location_id
LEFT JOIN games g ON g.room_id=target.id
WHERE b.room_id=source.id
  AND b.external_source='TIME_TO_GROW'
  AND lower(b.product_name) !~ 'krampus'
  AND lower(target.name)=CASE
    WHEN lower(b.product_name) IN ('color cube','call of cube','treasure island','star wars') THEN 'questboxes'
    ELSE 'vr'
  END
  AND (
    lower(b.product_name) IN (
      'friend pass','friendle pass','couple pass','general pass','kinder pass','kinder party'
    )
    OR lower(g.name)=lower(b.product_name)
  );

UPDATE bookings b
SET game_id=g.id
FROM rooms r
JOIN games g ON g.room_id=r.id AND lower(g.name)='krampus house'
WHERE b.room_id=r.id
  AND b.external_source='TIME_TO_GROW'
  AND lower(b.product_name) ~ 'krampus';

UPDATE sessions s
SET room_id=b.room_id,game_id=b.game_id
FROM bookings b
WHERE s.booking_id=b.id AND b.external_source='TIME_TO_GROW';

DELETE FROM rooms r
WHERE lower(r.name) IN (
  'vr central','vr sankt polten','friend pass','friendle pass','couple pass',
  'general pass','kinder pass','kinder party','sanctum survival','skips of world',
  'color cube','call of cube','treasure island','star wars'
)
AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.room_id=r.id)
AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.room_id=r.id)
AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.room_id=r.id)
AND NOT EXISTS (SELECT 1 FROM cameras c WHERE c.room_id=r.id)
AND NOT EXISTS (SELECT 1 FROM local_sites ls WHERE ls.room_id=r.id);
