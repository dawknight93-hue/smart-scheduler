/*
# Day routines

The Weekly Review only suggests goal sessions inside the time windows of the
day's routine. A day's type comes from the calendar — the same matching as big
life blocks (title words on all-day / 8h+ events; 'trips' = flight legs and
layovers away from MIA); the first matching routine in order wins and a day
that matches none uses the 'default' routine. A routine with no windows means
no goal sessions that day.

Single-tenant RLS (anon, USING true), matching every other table in this app.
*/

CREATE TABLE IF NOT EXISTS day_routines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  label text NOT NULL,
  kind text NOT NULL DEFAULT 'keywords' CHECK (kind IN ('keywords', 'trips', 'default')),
  keywords text NOT NULL DEFAULT '',
  windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE day_routines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_day_routines" ON day_routines;
CREATE POLICY "anon_select_day_routines" ON day_routines FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_day_routines" ON day_routines;
CREATE POLICY "anon_insert_day_routines" ON day_routines FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_day_routines" ON day_routines;
CREATE POLICY "anon_update_day_routines" ON day_routines FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_day_routines" ON day_routines;
CREATE POLICY "anon_delete_day_routines" ON day_routines FOR DELETE TO anon, authenticated USING (true);

INSERT INTO day_routines (key, label, kind, keywords, windows, position) VALUES
  ('uta', 'UTA', 'keywords', 'uta, drill weekend', '[]', 10),
  ('flying', 'Flying', 'trips', '', '[]', 20),
  ('reserve', 'Reserve', 'keywords', 'reserve', '[{"from":"09:00","to":"11:00"}]', 30),
  ('day_off', 'Day off', 'keywords', 'no flying, day off, off', '[{"from":"09:00","to":"12:00"},{"from":"19:00","to":"21:00"}]', 40),
  ('normal', 'Normal day', 'default', '', '[{"from":"09:00","to":"21:00"}]', 100)
ON CONFLICT (key) DO NOTHING;
