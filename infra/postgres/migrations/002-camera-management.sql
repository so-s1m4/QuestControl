UPDATE roles
SET permissions = permissions || '["cameras:*"]'::jsonb
WHERE name IN ('ADMIN', 'TECHNICIAN')
  AND NOT permissions ? 'cameras:*';
