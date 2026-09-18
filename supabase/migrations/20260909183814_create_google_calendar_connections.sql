/*
# Create Google Calendar connection settings

This migration adds the safe, non-secret configuration needed for four Google
Calendars. It does not store OAuth access tokens or refresh tokens. Those must
remain in a server-only integration once Google credentials are available.

## New Table

### calendar_connections
- id (uuid, primary key)
- name (text, not null) — friendly label shown in the app
- calendar_id (text, not null) — Google Calendar identifier
- role (text, not null) — `fixed_source` for read-only scheduling inputs or
  `schedule_target` for calendars that receive generated schedule blocks
- enabled (boolean, default true)
- last_synced_at (timestamptz, nullable)
- last_sync_error (text, nullable) — safe human-readable status only
- created_at and updated_at timestamps

## Security
- RLS is enabled.
- This is intentionally single-tenant configuration because the app has no
  sign-in screen yet, so anon and authenticated users receive CRUD access.
- No OAuth secrets or tokens are exposed through this table.
*/

CREATE TABLE IF NOT EXISTS calendar_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  calendar_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('fixed_source', 'schedule_target')),
  enabled boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_calendar_connections" ON calendar_connections;
CREATE POLICY "anon_select_calendar_connections" ON calendar_connections FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_calendar_connections" ON calendar_connections;
CREATE POLICY "anon_insert_calendar_connections" ON calendar_connections FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_calendar_connections" ON calendar_connections;
CREATE POLICY "anon_update_calendar_connections" ON calendar_connections FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_calendar_connections" ON calendar_connections;
CREATE POLICY "anon_delete_calendar_connections" ON calendar_connections FOR DELETE
  TO anon, authenticated USING (true);

INSERT INTO calendar_connections (name, calendar_id, role)
SELECT seed.name, seed.calendar_id, seed.role
FROM (VALUES
  ('Duty / Work', '', 'fixed_source'),
  ('Personal / Family', '', 'fixed_source'),
  ('Generated Tasks', '', 'schedule_target'),
  ('Generated Habits', '', 'schedule_target')
) AS seed(name, calendar_id, role)
WHERE NOT EXISTS (SELECT 1 FROM calendar_connections);
