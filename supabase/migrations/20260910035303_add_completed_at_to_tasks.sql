/*
# Add completed_at column to tasks

1. Modified Tables
- `tasks`
  - Adds `completed_at` (timestamptz, nullable) — when non-null, the task is done.
  - Default is NULL (incomplete), so existing rows are unaffected.
2. Security
- No policy changes needed; existing anon+authenticated CRUD policies already cover the new column.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'completed_at'
  ) THEN
    ALTER TABLE tasks ADD COLUMN completed_at timestamptz;
  END IF;
END $$;
