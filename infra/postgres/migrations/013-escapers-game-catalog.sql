INSERT INTO games(room_id,name)
SELECT r.id,game.name
FROM rooms r
CROSS JOIN (VALUES
  ('Dream Hackers'),
  ('Dream Hackers 2: The Prison of the Ancient Ones'),
  ('Dream Hackers 3: The Conspiracy of the Weavers'),
  ('Escape the Worlds'),
  ('Alice'),
  ('Jungle Quest'),
  ('Christmas'),
  ('House of Fear: Call of Blood'),
  ('House of Fear: Cursed Souls'),
  ('Chernobyl'),
  ('Survival'),
  ('The Prison'),
  ('Mission Sigma'),
  ('Cyberpunk'),
  ('House of Fear'),
  ('Sanctum'),
  ('Signal Lost'),
  ('Gunslinger'),
  ('Arena'),
  ('Archer'),
  ('Smash Point'),
  ('The Last Day Defense')
) AS game(name)
WHERE lower(r.name)='vr'
ON CONFLICT DO NOTHING;

UPDATE bookings b
SET game_id=NULL
FROM rooms r
WHERE b.room_id=r.id
  AND lower(r.name)='vr'
  AND (
    lower(b.product_name) ~ '^(friend|friends|friendle|couple|family)( day)? pass$'
    OR lower(b.product_name) ~ '^(general( vr)? (ticket|pass)|kinder ?(pass|party|geburtstag))$'
  );

UPDATE sessions s
SET game_id=NULL
FROM bookings b
WHERE s.booking_id=b.id
  AND b.game_id IS NULL
  AND (
    lower(b.product_name) ~ '^(friend|friends|friendle|couple|family)( day)? pass$'
    OR lower(b.product_name) ~ '^(general( vr)? (ticket|pass)|kinder ?(pass|party|geburtstag))$'
  );

UPDATE games g
SET is_active=false
WHERE EXISTS (
  SELECT 1
  FROM rooms r
  WHERE r.id=g.room_id AND lower(r.name)='vr'
)
AND (
  lower(g.name) ~ '^(friend|friends|friendle|couple|family)( day)? pass$'
  OR lower(g.name) ~ '^(general( vr)? (ticket|pass)|kinder ?(pass|party|geburtstag))$'
);
