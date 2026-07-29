WITH vr_locations AS (
  SELECT DISTINCT r.location_id
  FROM bookings b
  JOIN rooms r ON r.id=b.room_id
  WHERE b.external_source='TIME_TO_GROW'
    AND lower(b.product_name) IN (
      'friendle pass',
      'couple pass',
      'skips of world',
      'general pass',
      'kinder party',
      'sanctum survival'
    )
)
INSERT INTO rooms(location_id,name,kind,capacity,status)
SELECT location_id,'VR Central','VR',1,'OFFLINE'
FROM vr_locations
WHERE NOT EXISTS (
  SELECT 1
  FROM rooms r
  WHERE r.location_id=vr_locations.location_id
    AND lower(r.name)='vr central'
);

UPDATE bookings b
SET room_id=vr.id
FROM rooms old_room
JOIN rooms vr
  ON vr.location_id=old_room.location_id
 AND lower(vr.name)='vr central'
WHERE b.room_id=old_room.id
  AND b.external_source='TIME_TO_GROW'
  AND lower(b.product_name) IN (
    'friendle pass',
    'couple pass',
    'skips of world',
    'general pass',
    'kinder party',
    'sanctum survival'
  );

UPDATE sessions s
SET room_id=b.room_id
FROM bookings b
WHERE s.booking_id=b.id
  AND b.external_source='TIME_TO_GROW';

DELETE FROM rooms r
WHERE lower(r.name) IN (
    'friendle pass',
    'couple pass',
    'skips of world',
    'general pass',
    'kinder party',
    'sanctum survival'
  )
  AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.room_id=r.id)
  AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.room_id=r.id)
  AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.room_id=r.id);
