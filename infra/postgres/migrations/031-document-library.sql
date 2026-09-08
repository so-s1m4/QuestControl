CREATE TABLE IF NOT EXISTS document_library_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text NOT NULL DEFAULT 'OTHER' CHECK (category IN ('REPORT','LICENSE','EMPLOYEE','OTHER')),
  source text NOT NULL DEFAULT 'UPLOADED' CHECK (source IN ('UPLOADED','GENERATED')),
  file_name text NOT NULL,
  content_type text NOT NULL,
  file_data bytea NOT NULL,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  employee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_library_files_location_idx ON document_library_files(location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_library_files_employee_idx ON document_library_files(employee_id, created_at DESC);
