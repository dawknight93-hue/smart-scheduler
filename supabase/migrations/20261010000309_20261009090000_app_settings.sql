CREATE TABLE IF NOT EXISTS app_settings (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_app_settings" ON app_settings;
CREATE POLICY "anon_all_app_settings" ON app_settings FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- No starting row: a brand-new copy opens on first-time setup. (The original copy's row
-- was added when this table was first created there.)
