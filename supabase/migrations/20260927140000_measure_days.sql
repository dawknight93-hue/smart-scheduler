/*
# Days of the week for effort measures

goal_measures.days: the weekdays a scheduled effort should land on
(0 = Sunday … 6 = Saturday, like JavaScript's getDay), e.g. {2,4} for a
Tuesday/Thursday email review. Null or empty = any day. The Weekly Review only
proposes that effort's sessions on those days.
*/

ALTER TABLE goal_measures ADD COLUMN IF NOT EXISTS days smallint[];
