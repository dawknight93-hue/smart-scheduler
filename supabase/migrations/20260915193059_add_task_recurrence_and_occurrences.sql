/*
# Add recurrence rules to tasks and create task_occurrences table

1. Modified Tables
- `tasks`: adds recurrence rule columns so a task can repeat on a schedule.
  - recurrence_enabled boolean default false — whether this task recurs at all
  - recurrence_frequency text — 'daily', 'weekly', or 'monthly'
  - recurrence_interval int — every N days/weeks/months
  - recurrence_weekdays int[] — 0=Sun..6=Sat, which weekdays (weekly only)
  - recurrence_monthly_mode text — 'day_of_month' or 'weekday_of_month'
  - recurrence_monthly_day int — 1-31 (for day_of_month mode)
  - recurrence_monthly_week_n int — 1=first..4=fourth, -1=last (for weekday_of_month)
  - recurrence_monthly_weekday int — 0-6 (for weekday_of_month)
  - recurrence_end_mode text — 'never', 'on_date', or 'after_count'
  - recurrence_end_date timestamptz — end date (on_date mode)
  - recurrence_count int — total number of occurrences (after_count mode)

2. New Tables
- `task_occurrences`: tracks each occurrence of a recurring task independently.
  - id (uuid, primary key)
  - task_id (uuid, foreign key to tasks, ON DELETE CASCADE)
  - occurrence_date (date, not null) — the calendar date this occurrence falls on
  - completed (boolean, default false)
  - completed_at (timestamptz, nullable)
  - override_start (timestamptz, nullable) — set when dragged to a different time
  - override_end (timestamptz, nullable)
  - skipped (boolean, default false) — set when deleted, prevents re-rendering
  - created_at (timestamptz, default now())
  - UNIQUE(task_id, occurrence_date) — one row per occurrence per task

3. Security
- RLS enabled on task_occurrences.
- Allow anon + authenticated full CRUD (single-tenant, no auth, same as tasks).
*/

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS recurrence_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recurrence_frequency text,
  ADD COLUMN IF NOT EXISTS recurrence_interval int,
  ADD COLUMN IF NOT EXISTS recurrence_weekdays int[],
  ADD COLUMN IF NOT EXISTS recurrence_monthly_mode text,
  ADD COLUMN IF NOT EXISTS recurrence_monthly_day int,
  ADD COLUMN IF NOT EXISTS recurrence_monthly_week_n int,
  ADD COLUMN IF NOT EXISTS recurrence_monthly_weekday int,
  ADD COLUMN IF NOT EXISTS recurrence_end_mode text,
  ADD COLUMN IF NOT EXISTS recurrence_end_date timestamptz,
  ADD COLUMN IF NOT EXISTS recurrence_count int;

CREATE TABLE IF NOT EXISTS task_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  occurrence_date date NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  override_start timestamptz,
  override_end timestamptz,
  skipped boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(task_id, occurrence_date)
);

ALTER TABLE task_occurrences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_task_occurrences" ON task_occurrences;
CREATE POLICY "anon_select_task_occurrences" ON task_occurrences FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_task_occurrences" ON task_occurrences;
CREATE POLICY "anon_insert_task_occurrences" ON task_occurrences FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_task_occurrences" ON task_occurrences;
CREATE POLICY "anon_update_task_occurrences" ON task_occurrences FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_task_occurrences" ON task_occurrences;
CREATE POLICY "anon_delete_task_occurrences" ON task_occurrences FOR DELETE
  TO anon, authenticated USING (true);