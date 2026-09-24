/*
# Effort levels for energy-aware scheduling

- tasks.effort / habits.effort: 'focus' | 'routine' | 'light'. NULL means the
  app guesses from the title, context and length every time it schedules.
- effort_auto: true when the stored effort was the app's guess, false when you
  picked it yourself.
- effort_memory: your corrections, keyed by a normalized title (first four
  words, letters only), so similar items get the same effort next time.
  Single-tenant RLS (anon, USING true), matching every other table in this app.
*/

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS effort text CHECK (effort IN ('focus', 'routine', 'light')),
  ADD COLUMN IF NOT EXISTS effort_auto boolean NOT NULL DEFAULT true;

ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS effort text CHECK (effort IN ('focus', 'routine', 'light')),
  ADD COLUMN IF NOT EXISTS effort_auto boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS effort_memory (
  key text PRIMARY KEY,
  effort text NOT NULL CHECK (effort IN ('focus', 'routine', 'light')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE effort_memory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_effort_memory" ON effort_memory;
CREATE POLICY "anon_select_effort_memory" ON effort_memory FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_effort_memory" ON effort_memory;
CREATE POLICY "anon_insert_effort_memory" ON effort_memory FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_effort_memory" ON effort_memory;
CREATE POLICY "anon_update_effort_memory" ON effort_memory FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_effort_memory" ON effort_memory;
CREATE POLICY "anon_delete_effort_memory" ON effort_memory FOR DELETE
  TO anon, authenticated USING (true);
