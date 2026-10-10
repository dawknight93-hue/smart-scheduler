/*
# App settings (one row per copy of the app)

Who this copy is for: home time zone and airport, quiet hours, names for the
life roles, feature switches, and whether first-time setup is done. Stored as
one JSON document so new settings don't need new columns. With no row, the app
uses its built-in defaults (the original owner's setup).

## Security
- RLS on; anon + authenticated full access (single-tenant app, same as the other tables).
*/
CREATE TABLE IF NOT EXISTS app_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_app_settings" ON app_settings;
CREATE POLICY "anon_all_app_settings" ON app_settings FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- This copy is already set up: keep the built-in defaults, skip first-time setup.
INSERT INTO app_settings (id, settings) VALUES (1, '{"setupDone": true}'::jsonb) ON CONFLICT (id) DO NOTHING;
