/*
  # Completed activities from a source calendar

  Runna replaces a finished workout on its Google calendar with a "completed
  activity" event (its description carries a "📊 Summary" of distance, time and
  pace). The calendar sync sets `source_done` on those events so goals that
  count them tick them done automatically.

  1. Changes
    - `fixed_events.source_done` (boolean, default false)
*/
ALTER TABLE fixed_events ADD COLUMN IF NOT EXISTS source_done boolean NOT NULL DEFAULT false;
