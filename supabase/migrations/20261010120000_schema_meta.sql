/*
# Database version (schema_meta)

One row holding the version of the database layout, so each copy of the app can
tell when its database is missing an update the code needs (it shows a banner).
Every later migration ends with:
  UPDATE schema_meta SET version = <that migration's timestamp> WHERE id = 1;

## Security
- RLS on; anon + authenticated may read it (single-tenant app). Writes happen in migrations.
*/
CREATE TABLE IF NOT EXISTS schema_meta (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE schema_meta ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_read_schema_meta" ON schema_meta;
CREATE POLICY "anon_read_schema_meta" ON schema_meta FOR SELECT TO anon, authenticated USING (true);

INSERT INTO schema_meta (id, version) VALUES (1, 20261010120000)
ON CONFLICT (id) DO UPDATE SET version = GREATEST(schema_meta.version, EXCLUDED.version), updated_at = now();
