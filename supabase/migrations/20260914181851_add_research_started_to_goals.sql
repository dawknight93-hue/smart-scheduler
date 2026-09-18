/*
# Add research_started column to goals

1. Modified Tables
- goals: added `research_started` (boolean, not null, default false).
  This column tracks whether the research-recommendation conversation
  for a goal has been kicked off yet, so the app does not restart that
  conversation every time the goal is reopened.

2. Security
- No changes to RLS or policies.
*/

ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS research_started boolean NOT NULL DEFAULT false;
