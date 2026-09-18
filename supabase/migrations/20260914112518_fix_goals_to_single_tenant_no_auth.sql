/*
# Fix goals and goal_messages for single-tenant (no auth) architecture

The original goals migration assumed a multi-user app with real
authentication: user_id was NOT NULL DEFAULT auth.uid() with a FK to
auth.users, and RLS policies were scoped to the authenticated role
using auth.uid(). However, this app is single-tenant with no sign-in
flow — every existing table (fixed_events, habits, tasks,
calendar_connections) uses `TO anon, authenticated USING (true)` and
the frontend only ever sends the static anon key.

This migration corrects goals and goal_messages to match that pattern:

## Changes to goals table
- Drop the foreign key constraint from user_id to auth.users(id).
- Drop the NOT NULL constraint on user_id (it is now nullable).
- Drop the DEFAULT auth.uid() on user_id (no default).

## Changes to RLS policies on goals
- Drop the 4 auth.uid()-based policies (select/insert/update/delete
  scoped to TO authenticated).
- Create 4 new policies matching the existing single-tenant pattern:
  TO anon, authenticated USING (true) / WITH CHECK (true).

## Changes to RLS policies on goal_messages
- Drop the 4 EXISTS-based policies scoped to TO authenticated.
- Create 4 new policies matching the existing single-tenant pattern:
  TO anon, authenticated USING (true) / WITH CHECK (true).

## Security notes
- USING (true) is acceptable here because this is a personal single-user
  app with no authentication, matching the convention established in
  the original scheduler tables migration.
*/

ALTER TABLE goals DROP CONSTRAINT IF EXISTS goals_user_id_fkey;
ALTER TABLE goals ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE goals ALTER COLUMN user_id DROP DEFAULT;

DROP POLICY IF EXISTS "select_own_goals" ON goals;
CREATE POLICY "anon_select_goals" ON goals FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "insert_own_goals" ON goals;
CREATE POLICY "anon_insert_goals" ON goals FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "update_own_goals" ON goals;
CREATE POLICY "anon_update_goals" ON goals FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "delete_own_goals" ON goals;
CREATE POLICY "anon_delete_goals" ON goals FOR DELETE
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "select_own_goal_messages" ON goal_messages;
CREATE POLICY "anon_select_goal_messages" ON goal_messages FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "insert_own_goal_messages" ON goal_messages;
CREATE POLICY "anon_insert_goal_messages" ON goal_messages FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "update_own_goal_messages" ON goal_messages;
CREATE POLICY "anon_update_goal_messages" ON goal_messages FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "delete_own_goal_messages" ON goal_messages;
CREATE POLICY "anon_delete_goal_messages" ON goal_messages FOR DELETE
  TO anon, authenticated USING (true);
