-- Policies & Guidelines storage. Safe to run repeatedly; no existing data is removed.
CREATE TABLE IF NOT EXISTS academy_policy_versions (
  id SERIAL PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  effective_date DATE,
  sections JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS academy_policy_acknowledgements (
  id BIGSERIAL PRIMARY KEY,
  parent_id INTEGER NOT NULL REFERENCES parent_credentials(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  policy_version TEXT NOT NULL REFERENCES academy_policy_versions(version),
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (parent_id, student_id, policy_version)
);

CREATE INDEX IF NOT EXISTS idx_policy_ack_version
  ON academy_policy_acknowledgements(policy_version);

ALTER TABLE academy_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE academy_policy_acknowledgements ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    DROP POLICY IF EXISTS "Service role only" ON academy_policy_versions;
    CREATE POLICY "Service role only" ON academy_policy_versions
      FOR ALL TO service_role USING (true) WITH CHECK (true);
    DROP POLICY IF EXISTS "Service role only" ON academy_policy_acknowledgements;
    CREATE POLICY "Service role only" ON academy_policy_acknowledgements
      FOR ALL TO service_role USING (true) WITH CHECK (true);
    GRANT SELECT, INSERT, UPDATE, DELETE ON academy_policy_versions, academy_policy_acknowledgements TO anon, authenticated;
    GRANT ALL PRIVILEGES ON academy_policy_versions, academy_policy_acknowledgements TO service_role;
    GRANT USAGE, SELECT ON SEQUENCE academy_policy_versions_id_seq, academy_policy_acknowledgements_id_seq TO anon, authenticated, service_role;
  END IF;
END $$;
