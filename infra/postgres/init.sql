CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE TYPE room_kind AS ENUM ('REAL', 'VR');
CREATE TYPE entity_status AS ENUM ('ONLINE', 'OFFLINE', 'DEGRADED', 'DISABLED');
CREATE TABLE roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE NOT NULL, permissions jsonb NOT NULL DEFAULT '[]');
CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email citext UNIQUE NOT NULL, password_hash text NOT NULL, display_name text NOT NULL, role_id uuid REFERENCES roles(id), is_active boolean NOT NULL DEFAULT true, refresh_token_hash text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE locations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text UNIQUE, name text NOT NULL, timezone text NOT NULL DEFAULT 'Europe/Vienna', address text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE user_locations (user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE, PRIMARY KEY(user_id,location_id));
CREATE TABLE rooms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL REFERENCES locations(id), name text NOT NULL, kind room_kind NOT NULL, status entity_status NOT NULL DEFAULT 'OFFLINE', capacity int NOT NULL DEFAULT 1, metadata jsonb NOT NULL DEFAULT '{}');
CREATE TABLE integrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid REFERENCES locations(id), type text NOT NULL, name text NOT NULL, status entity_status NOT NULL DEFAULT 'OFFLINE', encrypted_config bytea, last_health_at timestamptz);
CREATE TABLE local_sites (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), room_id uuid REFERENCES rooms(id), agent_id text NOT NULL, name text NOT NULL, local_url text NOT NULL, allowed_methods text[] NOT NULL DEFAULT ARRAY['GET'], enabled boolean NOT NULL DEFAULT true);
CREATE TABLE cameras (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), room_id uuid REFERENCES rooms(id), integration_id uuid REFERENCES integrations(id), name text NOT NULL, provider text NOT NULL CHECK (provider IN ('TUYA','RTSP','ONVIF')), external_id text, stream_key text, status entity_status NOT NULL DEFAULT 'OFFLINE', config jsonb NOT NULL DEFAULT '{}');
CREATE TABLE devices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), room_id uuid REFERENCES rooms(id), agent_id text, name text NOT NULL, type text NOT NULL, status entity_status NOT NULL DEFAULT 'OFFLINE', last_seen timestamptz, config jsonb NOT NULL DEFAULT '{}');
CREATE TABLE bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), room_id uuid NOT NULL REFERENCES rooms(id), customer_name text NOT NULL, customer_phone text, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, players int NOT NULL, amount_cents int NOT NULL DEFAULT 0, currency char(3) NOT NULL DEFAULT 'EUR', payment_status text NOT NULL DEFAULT 'UNPAID', notes text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid REFERENCES bookings(id), room_id uuid NOT NULL REFERENCES rooms(id), status text NOT NULL, started_at timestamptz, ended_at timestamptz, remaining_seconds int, state jsonb NOT NULL DEFAULT '{}');
CREATE TABLE audit_logs (id bigserial PRIMARY KEY, actor_user_id uuid REFERENCES users(id), action text NOT NULL, entity_type text NOT NULL, entity_id text, ip inet, user_agent text, request_id uuid NOT NULL, before_state jsonb, after_state jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_logs_created_at_idx ON audit_logs(created_at DESC);
CREATE INDEX bookings_room_starts_idx ON bookings(room_id, starts_at);
INSERT INTO roles(name, permissions) VALUES
 ('OWNER','["*"]'), ('ADMIN','["bookings:*","rooms:*","locations:read","sessions:*","devices:read","cameras:*"]'),
 ('OPERATOR','["bookings:read","rooms:read","locations:read","sessions:*","devices:read","devices:command","cameras:read","local_sites:open"]'),
 ('TECHNICIAN','["rooms:read","locations:read","devices:*","integrations:*","cameras:*","audit:read"]')
ON CONFLICT DO NOTHING;
