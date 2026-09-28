/*
# Quiet-hours override for single sessions

Nothing is scheduled between 21:00 and 09:00. When you drag a habit or task
there a second time and confirm, it gets quiet_override = true: the scheduler
then keeps it exactly at the time you pinned it instead of moving it back into
the day.
*/

ALTER TABLE habits ADD COLUMN IF NOT EXISTS quiet_override boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS quiet_override boolean NOT NULL DEFAULT false;
