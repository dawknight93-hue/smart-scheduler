/*
# Proffer window times on the awareness rules

The day before a reserve day, the Briefing reminds you to proffer. It used to
need a "Proffer window" event on the calendar to know the times; now the
Proffer rule carries its usual window (opens_at / closes_at, HH:MM), used
whenever no proffer event is on the calendar that day. An event on the
calendar still wins.
*/

ALTER TABLE awareness_rules ADD COLUMN IF NOT EXISTS opens_at text;
ALTER TABLE awareness_rules ADD COLUMN IF NOT EXISTS closes_at text;

UPDATE awareness_rules
SET opens_at = '11:00', closes_at = '15:00'
WHERE role = 'proffer' AND opens_at IS NULL AND closes_at IS NULL;