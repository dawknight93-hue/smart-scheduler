/*
# Goal measures

How progress on a goal is measured. Each goal can have several:

- effort  — something you do on a weekly rhythm ("Run 4×/week", "Task block
  3 × 80 min = 4 h/week"). Reaches the calendar the same two ways the goal's
  weekly target always has: the app schedules sessions in free time, or it
  counts events already arriving from a calendar (e.g. Runna).
- outcome — a number you log on a rhythm (weight in lb, open tasks, PT score),
  with the direction that counts as progress, a baseline, a target, and dated
  checkpoints (e.g. ≤ 208.5 lb by Sep 30).

The planner suggests measures (status 'suggested'); you accept them ('active')
or dismiss them. measure_entries holds the numbers you log.

Existing plans carry over: each goal's current weekly target becomes its first
effort measure, its 🎯 sessions and past Weekly Review rows are attached to it.

habits.measure_id ties a scheduled 🎯 session to the effort measure it serves.
goal_week_reviews gets measure_key so each effort measure is reviewed on its
own ('' = a goal reviewed before measures existed).

Single-tenant RLS (anon, USING true), matching every other table in this app.
*/

CREATE TABLE IF NOT EXISTS goal_measures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  kind text NOT NULL CHECK (kind IN ('effort', 'outcome')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suggested', 'archived')),
  label text NOT NULL,
  why text,
  -- effort
  plan_mode text CHECK (plan_mode IN ('schedule', 'count')),
  sessions_per_week integer,
  session_minutes integer,
  hours_per_week numeric,
  context text CHECK (context IN ('desk', 'home', 'phone', 'errand', 'other')),
  preferred_time text NOT NULL DEFAULT 'any' CHECK (preferred_time IN ('any', 'morning', 'afternoon', 'evening')),
  effort text CHECK (effort IN ('focus', 'routine', 'light')),
  count_calendar_id text,
  count_keyword text,
  -- outcome
  unit text,
  direction text CHECK (direction IN ('down', 'up')),
  baseline numeric,
  target numeric,
  log_every text CHECK (log_every IN ('daily', 'weekly', 'monthly')),
  log_weekday integer CHECK (log_weekday BETWEEN 0 AND 6),
  checkpoints jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goal_measures_goal ON goal_measures(goal_id);

CREATE TABLE IF NOT EXISTS measure_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  measure_id uuid NOT NULL REFERENCES goal_measures(id) ON DELETE CASCADE,
  goal_id uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  value numeric NOT NULL,
  logged_on date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_measure_entries_measure ON measure_entries(measure_id, logged_on);

ALTER TABLE goal_measures ENABLE ROW LEVEL SECURITY;
ALTER TABLE measure_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_goal_measures" ON goal_measures;
CREATE POLICY "anon_select_goal_measures" ON goal_measures FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_goal_measures" ON goal_measures;
CREATE POLICY "anon_insert_goal_measures" ON goal_measures FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_goal_measures" ON goal_measures;
CREATE POLICY "anon_update_goal_measures" ON goal_measures FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_goal_measures" ON goal_measures;
CREATE POLICY "anon_delete_goal_measures" ON goal_measures FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_select_measure_entries" ON measure_entries;
CREATE POLICY "anon_select_measure_entries" ON measure_entries FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_measure_entries" ON measure_entries;
CREATE POLICY "anon_insert_measure_entries" ON measure_entries FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_measure_entries" ON measure_entries;
CREATE POLICY "anon_update_measure_entries" ON measure_entries FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_measure_entries" ON measure_entries;
CREATE POLICY "anon_delete_measure_entries" ON measure_entries FOR DELETE TO anon, authenticated USING (true);

-- Sessions and reviews per measure
ALTER TABLE habits ADD COLUMN IF NOT EXISTS measure_id uuid REFERENCES goal_measures(id) ON DELETE SET NULL;

ALTER TABLE goal_week_reviews ADD COLUMN IF NOT EXISTS measure_key text NOT NULL DEFAULT '';
ALTER TABLE goal_week_reviews DROP CONSTRAINT IF EXISTS goal_week_reviews_goal_id_week_start_key;
ALTER TABLE goal_week_reviews DROP CONSTRAINT IF EXISTS goal_week_reviews_goal_week_measure_key;
ALTER TABLE goal_week_reviews ADD CONSTRAINT goal_week_reviews_goal_week_measure_key UNIQUE (goal_id, week_start, measure_key);

-- Carry existing plans over: each goal's weekly target becomes its first effort measure.
INSERT INTO goal_measures (goal_id, position, kind, status, label, plan_mode, sessions_per_week, session_minutes, context, preferred_time, count_calendar_id, count_keyword)
SELECT g.id, 0, 'effort', 'active', COALESCE(NULLIF(g.weekly_target, ''), 'Session'), g.plan_mode, g.cadence_sessions_per_week,
       g.session_minutes, g.session_context, COALESCE(g.preferred_time, 'any'), g.count_calendar_id, g.count_keyword
FROM goals g
WHERE g.plan_mode IS NOT NULL
  AND COALESCE(g.cadence_sessions_per_week, 0) > 0
  AND NOT EXISTS (SELECT 1 FROM goal_measures m WHERE m.goal_id = g.id);

UPDATE habits h
SET measure_id = m.id
FROM goal_measures m
WHERE h.goal_id = m.goal_id AND h.measure_id IS NULL AND m.kind = 'effort' AND m.position = 0;

UPDATE goal_week_reviews r
SET measure_key = m.id::text
FROM goal_measures m
WHERE r.goal_id = m.goal_id AND r.measure_key = '' AND m.kind = 'effort' AND m.position = 0;