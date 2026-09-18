/*
# Add display-only calendars and non-blocking events

1. Modified Tables
- `calendar_connections`: allow the `display_only` role in addition to
  `fixed_source` and `schedule_target`.
- `fixed_events`: add `blocks_schedule`, which defaults to true so existing
  events continue to reserve time.
- `gcal_event_map`: allow `display_only` as a calendar role.

2. Behavior
- `fixed_source` calendars are pulled into the scheduler and block time.
- `display_only` calendars are pulled into the visible calendar but do not
  block time for habits or tasks.
- `schedule_target` calendars receive generated schedule blocks and are never
  read as fixed events.

3. Security
- Existing RLS policies remain unchanged because this migration only adds
  scheduling metadata and extends existing role checks.

4. Data Safety
- Existing fixed events are preserved and default to blocking the schedule.
- No rows, columns, or tables are deleted.
*/

ALTER TABLE fixed_events
  ADD COLUMN IF NOT EXISTS blocks_schedule boolean NOT NULL DEFAULT true;

ALTER TABLE calendar_connections
  DROP CONSTRAINT IF EXISTS calendar_connections_role_check;

ALTER TABLE calendar_connections
  ADD CONSTRAINT calendar_connections_role_check
  CHECK (role IN ('fixed_source', 'display_only', 'schedule_target'));

ALTER TABLE gcal_event_map
  DROP CONSTRAINT IF EXISTS gcal_event_map_calendar_role_check;

ALTER TABLE gcal_event_map
  ADD CONSTRAINT gcal_event_map_calendar_role_check
  CHECK (calendar_role IN ('fixed_source', 'display_only', 'schedule_target'));
