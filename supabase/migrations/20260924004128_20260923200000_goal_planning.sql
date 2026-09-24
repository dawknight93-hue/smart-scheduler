/*
# Goal planning: Cascade + Weekly Review

## goals — new columns
- plan_mode: how a goal's weekly target reaches the calendar
    'schedule' = the app places N sessions in free time each week
    'count'    = the app counts events already arriving from a calendar (e.g. Runna)
- session_minutes, session_context, preferred_time: shape of each scheduled session
- count_calendar_id, count_keyword: which calendar (and optional title keyword) to count
- cascade_generated_at: when milestones/weekly target were last generated
  (milestones and weekly_target columns already exist from the original goals table)

## habits — goal_id
Links sessions created by the Weekly Review back to their goal. ON DELETE SET NULL
so deleting a goal never deletes calendar items silently.

## goal_week_reviews
One row per goal per reviewed week: what was targeted, what got scheduled, and
whether it was approved, skipped, or short. Single-tenant RLS (anon, USING true),
matching every other table in this app.
*/

ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS plan_mode text CHECK (plan_mode IN ('schedule', 'count')),
  ADD COLUMN IF NOT EXISTS session_minutes integer,
  ADD COLUMN IF NOT EXISTS session_context text CHECK (session_context IN ('desk', 'home', 'phone', 'errand', 'other')),
  ADD COLUMN IF NOT EXISTS preferred_time text NOT NULL DEFAULT 'any' CHECK (preferred_time IN ('any', 'morning', 'afternoon', 'evening')),
  ADD COLUMN IF NOT EXISTS count_calendar_id text,
  ADD COLUMN IF NOT EXISTS count_keyword text,
  ADD COLUMN IF NOT EXISTS cascade_generated_at timestamptz;

ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS goal_id uuid REFERENCES goals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_habits_goal_id ON habits(goal_id);

CREATE TABLE IF NOT EXISTS goal_week_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  target_count integer NOT NULL DEFAULT 0,
  scheduled_count integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('approved', 'skipped', 'short')),
  note text,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (goal_id, week_start)
);

ALTER TABLE goal_week_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_goal_week_reviews" ON goal_week_reviews;
CREATE POLICY "anon_select_goal_week_reviews" ON goal_week_reviews FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_goal_week_reviews" ON goal_week_reviews;
CREATE POLICY "anon_insert_goal_week_reviews" ON goal_week_reviews FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_goal_week_reviews" ON goal_week_reviews;
CREATE POLICY "anon_update_goal_week_reviews" ON goal_week_reviews FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_goal_week_reviews" ON goal_week_reviews;
CREATE POLICY "anon_delete_goal_week_reviews" ON goal_week_reviews FOR DELETE
  TO anon, authenticated USING (true);