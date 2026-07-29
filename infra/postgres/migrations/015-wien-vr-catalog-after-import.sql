WITH wien_vr AS (
  SELECT r.id
  FROM rooms r
  JOIN locations l ON l.id=r.location_id
  WHERE lower(l.name) ~ 'wien|vienna'
    AND lower(r.name)='vr'
)
INSERT INTO games(room_id,name)
SELECT r.id,game.name
FROM wien_vr r
CROSS JOIN (VALUES
  ('Survival'),
  ('House of Fear'),
  ('Signal Lost'),
  ('Smash Point'),
  ('Sanctum'),
  ('The Prison'),
  ('Mission Sigma'),
  ('Jungle Quest'),
  ('Gunslinger'),
  ('Cyberpunk'),
  ('Christmas'),
  ('Escape the Worlds'),
  ('Dream Hackers'),
  ('Chornobyl'),
  ('Arena'),
  ('Archer'),
  ('Alice')
) AS game(name)
ON CONFLICT(room_id,lower(name)) DO UPDATE SET is_active=true;

UPDATE games g
SET is_active=false
FROM rooms r
JOIN locations l ON l.id=r.location_id
WHERE g.room_id=r.id
  AND lower(l.name) ~ 'wien|vienna'
  AND lower(r.name)='vr'
  AND (
    lower(g.name) ~ '^(friend|friends|friendle|couple|family)( day)? pass$'
    OR lower(g.name) ~ '^(general( vr)?( day)? (ticket|pass)|kinder ?(pass|party|geburtstag))$'
    OR lower(g.name)='any vr game'
  );

UPDATE bookings b
SET game_id=NULL
FROM rooms r
JOIN locations l ON l.id=r.location_id
WHERE b.room_id=r.id
  AND lower(l.name) ~ 'wien|vienna'
  AND lower(r.name)='vr'
  AND (
    lower(b.product_name) ~ '^(friend|friends|friendle|couple|family)( day)? pass$'
    OR lower(b.product_name) ~ '^(general( vr)?( day)? (ticket|pass)|kinder ?(pass|party|geburtstag)|any vr game)$'
  );

UPDATE sessions s
SET game_id=NULL
FROM bookings b
JOIN rooms r ON r.id=b.room_id
JOIN locations l ON l.id=r.location_id
WHERE s.booking_id=b.id
  AND lower(l.name) ~ 'wien|vienna'
  AND lower(r.name)='vr'
  AND b.game_id IS NULL;
