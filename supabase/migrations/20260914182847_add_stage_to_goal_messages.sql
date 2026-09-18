/*
# Add stage column to goal_messages

1. Modified Tables
- goal_messages: added `stage` (text, not null, default 'smart')
  with a CHECK constraint restricting values to 'smart' or 'research'.
  This lets application code distinguish which conversation phase
  a message belongs to.

2. Security
- No changes to RLS or policies.
*/

ALTER TABLE goal_messages
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'smart'
  CHECK (stage IN ('smart', 'research'));
