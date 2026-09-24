/*
# Goal planning: Daily level of the cascade

## goal_daily_items
One row per goal session per day — the "Daily" tier of
Yearly → Quarterly → Monthly → Weekly → Daily.

- Schedule-mode goals: created when the Weekly Review approves a week, one row per
  🎯 session (habit_id), with a short focus line and optional steps written from
  the goal's next checkpoint. Deleting the session deletes its daily item.
- Count-mode goals (e.g. Runna): the sessions come from another calendar, so a row
  is only written when a session is ticked done; source_item_id is the counted
  fixed event.

done/done_at record what actually happened, so the Review and Briefing can show
"done" rather than just "scheduled". Single-tenant RLS (anon, USING true),
matching every other table in this app.
*/

CREATE TABLE IF NOT EXISTS goal_daily_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  day date NOT NULL,
  habit_id uuid REFERENCES habits(id) ON DELETE CASCADE,
  source_item_id text,
  start_at timestamptz,
  minutes integer,
  focus text NOT NULL DEFAULT '',
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  done boolean NOT NULL DEFAULT false,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goal_daily_items_goal_week ON goal_daily_items(goal_id, week_start);
CREATE INDEX IF NOT EXISTS idx_goal_daily_items_day ON goal_daily_items(day);
-- Plain (not partial) unique constraints so upserts can target them; NULLs never collide.
ALTER TABLE goal_daily_items DROP CONSTRAINT IF EXISTS goal_daily_items_habit_key;
ALTER TABLE goal_daily_items ADD CONSTRAINT goal_daily_items_habit_key UNIQUE (habit_id);
ALTER TABLE goal_daily_items DROP CONSTRAINT IF EXISTS goal_daily_items_source_key;
ALTER TABLE goal_daily_items ADD CONSTRAINT goal_daily_items_source_key UNIQUE (goal_id, source_item_id);

ALTER TABLE goal_daily_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_goal_daily_items" ON goal_daily_items;
CREATE POLICY "anon_select_goal_daily_items" ON goal_daily_items FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_goal_daily_items" ON goal_daily_items;
CREATE POLICY "anon_insert_goal_daily_items" ON goal_daily_items FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_goal_daily_items" ON goal_daily_items;
CREATE POLICY "anon_update_goal_daily_items" ON goal_daily_items FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_goal_daily_items" ON goal_daily_items;
CREATE POLICY "anon_delete_goal_daily_items" ON goal_daily_items FOR DELETE
  TO anon, authenticated USING (true);