/*
# Read-only Google events

Google Calendar publishes what you're allowed to do with each calendar and event:
- calendarList / events.list return accessRole for the calendar
  ("owner" | "writer" | "reader" | "freeBusyReader").
- each event carries organizer.self, guestsCanModify and locked.

gcal-sync now reads these on every pull and records:
- calendar_connections.access_role — the calendar's accessRole as Google reports it.
- fixed_events.google_can_edit — false when Google wouldn't let you change the event
  (a calendar you can only read, a locked event, or an invite whose organizer
  doesn't let guests change it). The app then locks the event: no drag, resize,
  edit or delete — matching Google.
*/

ALTER TABLE calendar_connections
  ADD COLUMN IF NOT EXISTS access_role text;

ALTER TABLE fixed_events
  ADD COLUMN IF NOT EXISTS google_can_edit boolean NOT NULL DEFAULT true;