UPDATE cameras
SET room_id=(
  SELECT id FROM rooms
  WHERE lower(replace(name,' ','_')) LIKE '%krampus%'
  ORDER BY id
  LIMIT 1
)
WHERE provider='TUYA'
  AND room_id IS NULL
  AND name ~* '(LSC|PTZ)'
  AND EXISTS(
    SELECT 1 FROM rooms
    WHERE lower(replace(name,' ','_')) LIKE '%krampus%'
  );
