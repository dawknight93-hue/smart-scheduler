-- Add is_all_day column to fixed_events for all-day Google Calendar events
ALTER TABLE fixed_events ADD COLUMN IF NOT EXISTS is_all_day boolean DEFAULT false;
