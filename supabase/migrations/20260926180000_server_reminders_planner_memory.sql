/*
# Server-side reminders, trip alerts, and planner memory

- reminder_settings.weekly / monthly / trips: switches for reminders the server
  sends on its own, without the app having been opened:
    weekly  — Sunday 21:30, Weekly Review and weekly briefing
    monthly — last day of the month, 20:00, monthly briefing
    trips   — a new flight appears on your calendar in the next few days
              (e.g. a reserve assignment), found by a background Google sync
- briefing_memory.scope: the same memory now serves two writers —
  'briefing' (the Briefing summary) and 'planner' (goal coach, plans,
  measures and daily focus). Existing notes stay 'briefing'.
- pg_cron job 'gcal-background-pull' runs a Google Calendar pull every 15
  minutes so new trips are noticed even when the app is closed.
*/

ALTER TABLE reminder_settings ADD COLUMN IF NOT EXISTS weekly boolean NOT NULL DEFAULT true;
ALTER TABLE reminder_settings ADD COLUMN IF NOT EXISTS monthly boolean NOT NULL DEFAULT true;
ALTER TABLE reminder_settings ADD COLUMN IF NOT EXISTS trips boolean NOT NULL DEFAULT true;

ALTER TABLE briefing_memory ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'briefing';
ALTER TABLE briefing_memory DROP CONSTRAINT IF EXISTS briefing_memory_scope_check;
ALTER TABLE briefing_memory ADD CONSTRAINT briefing_memory_scope_check CHECK (scope IN ('briefing', 'planner'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gcal-background-pull') THEN
    PERFORM cron.unschedule('gcal-background-pull');
  END IF;
END $$;

SELECT cron.schedule(
  'gcal-background-pull',
  '*/15 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://pgjdhdsgciflvwbqtcjm.supabase.co/functions/v1/gcal-sync',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{"action": "background-pull"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);
