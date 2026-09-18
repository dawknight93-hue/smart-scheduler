/*
# Create scheduler tables (single-tenant, no auth)

This app is a personal weekly scheduling engine. It stores three kinds of
items that get placed onto a weekly calendar grid:

1. Fixed events — immovable blocks (duty, sim sessions, family commitments)
2. Habits — recurring protected time blocks with a priority tier
3. Tasks — one-off to-dos with a priority tier, deadline, and context tag

The scheduling engine reads all three, batches short tasks together by
context, then places everything into free slots ordered by priority tier
and deadline.

## New Tables

### fixed_events
- id (uuid, primary key)
- name (text, not null)
- start_time (timestamptz, not null)
- end_time (timestamptz, not null)
- created_at (timestamptz, default now())

### habits
- id (uuid, primary key)
- name (text, not null)
- tier (int, not null, 1=highest priority)
- duration_min (int, not null)
- search_start (timestamptz, not null) — earliest the habit can be placed
- search_end (timestamptz, not null) — latest the habit can be placed
- context (text, not null) — e.g. "home", "desk", "phone"
- created_at (timestamptz, default now())

### tasks
- id (uuid, primary key)
- name (text, not null)
- tier (int, not null, 1=highest priority)
- duration_min (int, not null)
- search_start (timestamptz, not null) — earliest the task can start
- deadline (timestamptz, not null) — must be completed by this time
- context (text, not null) — e.g. "home", "desk", "phone"
- created_at (timestamptz, default now())

## Security
- RLS enabled on all three tables.
- All tables allow anon + authenticated full CRUD (single-tenant, no sign-in).
- USING (true) is acceptable because the data is intentionally shared/public
  for this personal single-user app with no authentication.
*/

CREATE TABLE IF NOT EXISTS fixed_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE fixed_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_fixed_events" ON fixed_events;
CREATE POLICY "anon_select_fixed_events" ON fixed_events FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_fixed_events" ON fixed_events;
CREATE POLICY "anon_insert_fixed_events" ON fixed_events FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_fixed_events" ON fixed_events;
CREATE POLICY "anon_update_fixed_events" ON fixed_events FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_fixed_events" ON fixed_events;
CREATE POLICY "anon_delete_fixed_events" ON fixed_events FOR DELETE
  TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS habits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  tier int NOT NULL,
  duration_min int NOT NULL,
  search_start timestamptz NOT NULL,
  search_end timestamptz NOT NULL,
  context text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE habits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_habits" ON habits;
CREATE POLICY "anon_select_habits" ON habits FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_habits" ON habits;
CREATE POLICY "anon_insert_habits" ON habits FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_habits" ON habits;
CREATE POLICY "anon_update_habits" ON habits FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_habits" ON habits;
CREATE POLICY "anon_delete_habits" ON habits FOR DELETE
  TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  tier int NOT NULL,
  duration_min int NOT NULL,
  search_start timestamptz NOT NULL,
  deadline timestamptz NOT NULL,
  context text NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_tasks" ON tasks;
CREATE POLICY "anon_select_tasks" ON tasks FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_tasks" ON tasks;
CREATE POLICY "anon_insert_tasks" ON tasks FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_tasks" ON tasks;
CREATE POLICY "anon_update_tasks" ON tasks FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_tasks" ON tasks;
CREATE POLICY "anon_delete_tasks" ON tasks FOR DELETE
  TO anon, authenticated USING (true);
