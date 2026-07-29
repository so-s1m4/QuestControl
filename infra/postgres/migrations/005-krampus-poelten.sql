INSERT INTO locations(external_id,name,timezone,address)
VALUES(
  '01js4ahx79xbw5gd05jy1mmsdw',
  'Escapers_Peolten',
  'Europe/Vienna',
  'St. Pölten, Traisenpark EKZ Traisenpark auf der Fläche Top-Nr. EG S35B'
)
ON CONFLICT(external_id) WHERE external_id IS NOT NULL
DO UPDATE SET name=excluded.name,timezone=excluded.timezone,address=excluded.address;

UPDATE rooms
SET location_id=(
  SELECT id FROM locations
  WHERE external_id='01js4ahx79xbw5gd05jy1mmsdw'
)
WHERE lower(replace(name,' ','_')) LIKE '%krampus%';
