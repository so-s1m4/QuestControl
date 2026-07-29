UPDATE rooms
SET location_id=(
  SELECT id FROM locations
  WHERE external_id='01js4ahx79xbw5gd05jy1mmsdw'
)
WHERE location_id IN (
  SELECT id FROM locations
  WHERE external_id IS DISTINCT FROM '01js4ahx79xbw5gd05jy1mmsdw'
    AND lower(replace(name,' ','_')) LIKE '%krampus%'
);

UPDATE integrations
SET location_id=(
  SELECT id FROM locations
  WHERE external_id='01js4ahx79xbw5gd05jy1mmsdw'
)
WHERE location_id IN (
  SELECT id FROM locations
  WHERE external_id IS DISTINCT FROM '01js4ahx79xbw5gd05jy1mmsdw'
    AND lower(replace(name,' ','_')) LIKE '%krampus%'
);

DELETE FROM locations
WHERE external_id IS DISTINCT FROM '01js4ahx79xbw5gd05jy1mmsdw'
  AND lower(replace(name,' ','_')) LIKE '%krampus%';
