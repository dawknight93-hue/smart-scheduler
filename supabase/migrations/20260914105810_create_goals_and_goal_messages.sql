/*
# Create goals and goal_messages tables (multi-user, owner-scoped)

This migration adds two new tables for the Goals feature:

1. `goals` — Stores user goals tied to one of the 7 life pillars. Each
   goal follows the SMART framework (Specific, Measurable, Achievable,
   Relevant, Time-bound) and progresses through a lifecycle status from
   draft → smart_approved → approach_chosen → cadence_pending → active
   → complete (or missed / abandoned). The goal also tracks the chosen
   approach, cadence, milestones, and an optional weekly target.

2. `goal_messages` — Stores the SMART Gate conversation history per goal.
   Each message has a role (user or assistant) and text content. Messages
   are deleted automatically when the parent goal is deleted.

This is a SCHEMA-ONLY migration. No UI, components, or application logic
is added in this step.

## New Tables

### goals
- id (uuid, primary key, default gen_random_uuid())
- user_id (uuid, not null, default auth.uid(), references auth.users(id)
  ON DELETE CASCADE) — Owner of the goal. Defaults to the authenticated
  user so inserts that omit user_id still satisfy RLS.
- pillar (text, not null, CHECK in one of: spiritual, family, mil_career,
  civ_career, financial, physical, mental) — Which life pillar this goal
  belongs to.
- specific (text, nullable) — The "S" in SMART: what exactly will be done
- measurable (text, nullable) — The "M": how progress is tracked
- achievable (text, nullable) — The "A": why it's realistic
- relevant (text, nullable) — The "R": why it matters
- time_bound (text, nullable) — The "T": deadline or timeframe
- status (text, not null, default 'draft', CHECK in one of: draft,
  smart_approved, approach_chosen, cadence_pending, active, missed,
  complete, abandoned) — Lifecycle state of the goal
- approach (text, nullable) — The chosen approach/strategy
- cadence (text, nullable) — How often the goal is pursued
- milestones (jsonb, not null, default '[]') — Array of milestone objects
- weekly_target (text, nullable) — What needs to happen each week
- deadline (timestamptz, nullable) — Optional hard deadline
- created_at (timestamptz, not null, default now())
- updated_at (timestamptz, not null, default now())

### goal_messages
- id (uuid, primary key, default gen_random_uuid())
- goal_id (uuid, not null, references goals(id) ON DELETE CASCADE) —
  The goal this message belongs to. Messages are auto-deleted with the goal.
- role (text, not null, CHECK in ('user', 'assistant')) — Who sent the message
- content (text, not null) — The message text
- created_at (timestamptz, not null, default now())

## Indexes
- idx_goals_user_id on goals(user_id) — fast lookup of a user's goals
- idx_goal_messages_goal_id on goal_messages(goal_id) — fast lookup of
  messages for a given goal

## Security
- RLS enabled on both tables.
- goals: 4 owner-scoped CRUD policies (TO authenticated, auth.uid() = user_id).
  user_id defaults to auth.uid() so inserts omitting user_id succeed.
- goal_messages: 4 CRUD policies scoped through the parent goal's user_id
  using EXISTS subquery (TO authenticated).
*/

CREATE TABLE IF NOT EXISTS goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  pillar text NOT NULL CHECK (pillar IN ('spiritual', 'family', 'mil_career', 'civ_career', 'financial', 'physical', 'mental')),
  specific text,
  measurable text,
  achievable text,
  relevant text,
  time_bound text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'smart_approved', 'approach_chosen', 'cadence_pending', 'active', 'missed', 'complete', 'abandoned')),
  approach text,
  cadence text,
  milestones jsonb NOT NULL DEFAULT '[]'::jsonb,
  weekly_target text,
  deadline timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_goals" ON goals;
CREATE POLICY "select_own_goals" ON goals FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "insert_own_goals" ON goals;
CREATE POLICY "insert_own_goals" ON goals FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "update_own_goals" ON goals;
CREATE POLICY "update_own_goals" ON goals FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "delete_own_goals" ON goals;
CREATE POLICY "delete_own_goals" ON goals FOR DELETE
  TO authenticated USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_goals_user_id ON goals(user_id);

CREATE TABLE IF NOT EXISTS goal_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE goal_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own_goal_messages" ON goal_messages;
CREATE POLICY "select_own_goal_messages" ON goal_messages FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM goals WHERE goals.id = goal_messages.goal_id AND goals.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "insert_own_goal_messages" ON goal_messages;
CREATE POLICY "insert_own_goal_messages" ON goal_messages FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM goals WHERE goals.id = goal_messages.goal_id AND goals.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "update_own_goal_messages" ON goal_messages;
CREATE POLICY "update_own_goal_messages" ON goal_messages FOR UPDATE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM goals WHERE goals.id = goal_messages.goal_id AND goals.user_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM goals WHERE goals.id = goal_messages.goal_id AND goals.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "delete_own_goal_messages" ON goal_messages;
CREATE POLICY "delete_own_goal_messages" ON goal_messages FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM goals WHERE goals.id = goal_messages.goal_id AND goals.user_id = auth.uid())
  );

CREATE INDEX IF NOT EXISTS idx_goal_messages_goal_id ON goal_messages(goal_id);
