/*
  # Close bands for logged numbers, banking for efforts

  1. Changes
    - `goal_measures.tolerance` (numeric, nullable): a checkpoint missed by no
      more than this reads "close" instead of "missed" (e.g. 1 lb, 2 items).
    - `goal_measures.bankable` (boolean, default false): for a weekly effort,
      sessions beyond last week's target (up to one week's worth) count toward
      this week.
*/
ALTER TABLE goal_measures ADD COLUMN IF NOT EXISTS tolerance numeric;
ALTER TABLE goal_measures ADD COLUMN IF NOT EXISTS bankable boolean NOT NULL DEFAULT false;
