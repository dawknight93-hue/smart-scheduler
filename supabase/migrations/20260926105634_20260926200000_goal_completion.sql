/*
# Goal completion

The last step of a goal's lifecycle (draft → … → active → complete).

- completed_at: when you marked it complete (also set when a goal is let go
  or missed, so closed goals sort by when they ended).
- outcome_note: optional words about how it ended ("Hit 189.6 lb on Nov 20").

Completing a goal stops planning it: its future 🎯 sessions are removed and it
drops out of the Weekly Review, Briefing and reminders. Its measures, logged
numbers and checkpoints are kept as history, and it can be reopened.
*/

ALTER TABLE goals ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS outcome_note text;