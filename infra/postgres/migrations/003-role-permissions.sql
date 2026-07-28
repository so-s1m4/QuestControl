UPDATE roles SET permissions='["bookings:*","rooms:*","locations:read","sessions:*","devices:read","cameras:*"]'::jsonb WHERE name='ADMIN';
UPDATE roles SET permissions='["bookings:read","rooms:read","sessions:*","devices:command","cameras:read","local_sites:open"]'::jsonb WHERE name='OPERATOR';
UPDATE roles SET permissions='["rooms:read","locations:read","devices:*","integrations:*","cameras:*","audit:read"]'::jsonb WHERE name='TECHNICIAN';
