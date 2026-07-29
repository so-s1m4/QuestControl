WITH wien_locations AS (
  SELECT id FROM locations WHERE lower(name) ~ 'wien|vienna'
)
INSERT INTO rooms(location_id,name,kind,capacity,status)
SELECT l.id,zone.name,'REAL',zone.capacity,'OFFLINE'
FROM wien_locations l
CROSS JOIN (VALUES ('Gambling Jack',5),('Donau Piraten',8)) AS zone(name,capacity)
WHERE NOT EXISTS (
  SELECT 1 FROM rooms r
  WHERE r.location_id=l.id AND lower(r.name)=lower(zone.name)
);

WITH wien_vr AS (
  SELECT r.id
  FROM rooms r
  JOIN locations l ON l.id=r.location_id
  WHERE lower(l.name) ~ 'wien|vienna' AND lower(r.name)='vr'
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
ON CONFLICT DO NOTHING;

UPDATE games g
SET is_active=false
FROM rooms r
JOIN locations l ON l.id=r.location_id
WHERE g.room_id=r.id
  AND lower(l.name) ~ 'wien|vienna'
  AND lower(r.name)='vr'
  AND lower(g.name) NOT IN (
    'survival','house of fear','signal lost','smash point','sanctum','the prison',
    'mission sigma','jungle quest','gunslinger','cyberpunk','christmas',
    'escape the worlds','dream hackers','chornobyl','arena','archer','alice'
  );

INSERT INTO games(room_id,name)
SELECT r.id,r.name
FROM rooms r
JOIN locations l ON l.id=r.location_id
WHERE lower(l.name) ~ 'wien|vienna'
  AND lower(r.name) IN ('gambling jack','donau piraten')
ON CONFLICT DO NOTHING;

UPDATE bookings b
SET room_id=target.id,game_id=g.id
FROM rooms source
JOIN locations l ON l.id=source.location_id
JOIN rooms target ON target.location_id=l.id
JOIN games g ON g.room_id=target.id
WHERE b.room_id=source.id
  AND b.external_source='TIME_TO_GROW'
  AND lower(l.name) ~ 'wien|vienna'
  AND (
    (lower(b.product_name) ~ 'gambling jack' AND lower(target.name)='gambling jack' AND lower(g.name)='gambling jack')
    OR
    (lower(b.product_name) ~ 'donau piraten|danube pirates' AND lower(target.name)='donau piraten' AND lower(g.name)='donau piraten')
  );

UPDATE sessions s
SET room_id=b.room_id,game_id=b.game_id
FROM bookings b
WHERE s.booking_id=b.id AND b.external_source='TIME_TO_GROW';
