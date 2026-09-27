/*
# Tracking periods and big life blocks

1. Effort measures get a period. `sessions_per_week` keeps holding the count,
   and `period` says what it counts per: day, week (unchanged default), month,
   quarter or year — e.g. "Date night · 1 per month". The Weekly Review paces
   monthly/quarterly/yearly counts across the period's weeks.

2. Big life blocks: stretches of life that compete with goal time — UTA,
   flying trips, vacation, civilian training, annual tour. Each block is found
   on the calendar by keywords in event titles (all-day or 8h+ events), except
   'trips' (flight legs and layovers away from MIA) — editable in the app.

3. Each goal says which blocks it must avoid (`blocked_blocks`, empty = may be
   scheduled during any block) and whether you've answered that yet
   (`blocks_asked`), so the app asks once per goal.

Single-tenant RLS (anon, USING true), matching every other table in this app.
*/

ALTER TABLE goal_measures ADD COLUMN IF NOT EXISTS period text NOT NULL DEFAULT 'week';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'goal_measures_period_check') THEN
    ALTER TABLE goal_measures ADD CONSTRAINT goal_measures_period_check CHECK (period IN ('day', 'week', 'month', 'quarter', 'year'));
  END IF;
END $$;

ALTER TABLE goals ADD COLUMN IF NOT EXISTS blocked_blocks text[] NOT NULL DEFAULT '{}';
ALTER TABLE goals ADD COLUMN IF NOT EXISTS blocks_asked boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS life_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  label text NOT NULL,
  kind text NOT NULL DEFAULT 'keywords' CHECK (kind IN ('keywords', 'trips')),
  keywords text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE life_blocks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_select_life_blocks" ON life_blocks;
CREATE POLICY "anon_select_life_blocks" ON life_blocks FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_life_blocks" ON life_blocks;
CREATE POLICY "anon_insert_life_blocks" ON life_blocks FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_life_blocks" ON life_blocks;
CREATE POLICY "anon_update_life_blocks" ON life_blocks FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_life_blocks" ON life_blocks;
CREATE POLICY "anon_delete_life_blocks" ON life_blocks FOR DELETE TO anon, authenticated USING (true);

INSERT INTO life_blocks (key, label, kind, keywords, position) VALUES
  ('uta', 'UTA', 'keywords', 'uta, drill weekend', 10),
  ('flying', 'Flying', 'trips', '', 20),
  ('vacation', 'Vacation', 'keywords', 'vacation, pto, leave', 30),
  ('civ_training', 'Civ Training', 'keywords', 'recurrent, recurrent training', 40),
  ('annual_tour', 'Annual Tour', 'keywords', 'annual tour, annual training', 50)
ON CONFLICT (key) DO NOTHING;
