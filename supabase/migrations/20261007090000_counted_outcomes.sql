/*
  # Numbers that count an effort's ticks

  A counting number (e.g. "Check-ins Completed") can take its value from the
  ticked sessions of an effort on the same goal (e.g. "Weekly Check-in"), so
  ticking a session moves the number instead of logging it twice.

  1. Changes
    - `goal_measures.counts_measure_id` (uuid, nullable, references goal_measures)
*/
ALTER TABLE goal_measures ADD COLUMN IF NOT EXISTS counts_measure_id uuid REFERENCES goal_measures(id) ON DELETE SET NULL;
