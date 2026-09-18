/*
# Add OAuth tokens, sync tracking, and event mapping tables

This migration adds the tables needed for two-way Google Calendar sync:

1. **gcal_oauth_tokens** — stores the Google refresh token (server-only access).
   The access token is short-lived and cached here between sync runs.
2. **gcal_sync_runs** — audit log of each sync operation (pull/push, status, counts).
3. **gcal_event_map** — maps between our fixed_events/habits/tasks and Google Calendar
   event IDs, so we can update/delete the right Google event on re-syncs.

## New Tables

### gcal_oauth_tokens
- id (uuid, primary key)
- refresh_token (text, not null) — long-lived Google OAuth refresh token
- access_token (text, nullable) — short-lived, cached between syncs
- access_token_expires_at (timestamptz, nullable)
- email (text, nullable) — the Google account email for display
- created_at, updated_at timestamps

### gcal_sync_runs
- id (uuid, primary key)
- direction (text, not null) — 'pull' or 'push'
- status (text, not null) — 'success', 'error', or 'partial'
- events_pulled (int, default 0)
- events_pushed (int, default 0)
- events_deleted (int, default 0)
- error_message (text, nullable)
- created_at timestamp

### gcal_event_map
- id (uuid, primary key)
- google_event_id (text, not null) — Google Calendar event ID
- item_type (text, not null) — 'fixed_event', 'habit', or 'task'
- item_id (uuid, nullable) — our DB row ID (nullable for batched tasks)
- item_name (text, not null) — snapshot of the name at sync time
- calendar_role (text, not null) — 'fixed_source' or 'schedule_target'
- calendar_id (text, not null) — which Google calendar it was written to/read from
- start_time (timestamptz, not null)
- end_time (timestamptz, not null)
- synced_at (timestamptz, not null, default now())

## Security
- RLS enabled on all tables.
- gcal_oauth_tokens: anon+authenticated CRUD (single-tenant, no sign-in yet).
  In production with auth, this table should be authenticated-only and the
  refresh_token column should be revoked from client access. For now, the
  edge function uses the service role key to read/write this table, so the
  anon key client never needs direct access.
- gcal_sync_runs and gcal_event_map: anon+authenticated CRUD (single-tenant).
*/

CREATE TABLE IF NOT EXISTS gcal_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refresh_token text NOT NULL,
  access_token text,
  access_token_expires_at timestamptz,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE gcal_oauth_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_gcal_oauth_tokens" ON gcal_oauth_tokens;
CREATE POLICY "anon_all_gcal_oauth_tokens" ON gcal_oauth_tokens FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_gcal_oauth_tokens" ON gcal_oauth_tokens;
CREATE POLICY "anon_insert_gcal_oauth_tokens" ON gcal_oauth_tokens FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_gcal_oauth_tokens" ON gcal_oauth_tokens;
CREATE POLICY "anon_update_gcal_oauth_tokens" ON gcal_oauth_tokens FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_gcal_oauth_tokens" ON gcal_oauth_tokens;
CREATE POLICY "anon_delete_gcal_oauth_tokens" ON gcal_oauth_tokens FOR DELETE
  TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS gcal_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction text NOT NULL CHECK (direction IN ('pull', 'push')),
  status text NOT NULL CHECK (status IN ('success', 'error', 'partial')),
  events_pulled int NOT NULL DEFAULT 0,
  events_pushed int NOT NULL DEFAULT 0,
  events_deleted int NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE gcal_sync_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_gcal_sync_runs" ON gcal_sync_runs;
CREATE POLICY "anon_select_gcal_sync_runs" ON gcal_sync_runs FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_gcal_sync_runs" ON gcal_sync_runs;
CREATE POLICY "anon_insert_gcal_sync_runs" ON gcal_sync_runs FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_gcal_sync_runs" ON gcal_sync_runs;
CREATE POLICY "anon_update_gcal_sync_runs" ON gcal_sync_runs FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_gcal_sync_runs" ON gcal_sync_runs;
CREATE POLICY "anon_delete_gcal_sync_runs" ON gcal_sync_runs FOR DELETE
  TO anon, authenticated USING (true);

CREATE TABLE IF NOT EXISTS gcal_event_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_event_id text NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('fixed_event', 'habit', 'task')),
  item_id uuid,
  item_name text NOT NULL,
  calendar_role text NOT NULL CHECK (calendar_role IN ('fixed_source', 'schedule_target')),
  calendar_id text NOT NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE gcal_event_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_gcal_event_map" ON gcal_event_map;
CREATE POLICY "anon_select_gcal_event_map" ON gcal_event_map FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_gcal_event_map" ON gcal_event_map;
CREATE POLICY "anon_insert_gcal_event_map" ON gcal_event_map FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_gcal_event_map" ON gcal_event_map;
CREATE POLICY "anon_update_gcal_event_map" ON gcal_event_map FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_gcal_event_map" ON gcal_event_map;
CREATE POLICY "anon_delete_gcal_event_map" ON gcal_event_map FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_gcal_event_map_google_id ON gcal_event_map (google_event_id);
CREATE INDEX IF NOT EXISTS idx_gcal_event_map_item ON gcal_event_map (item_type, item_id);
CREATE INDEX IF NOT EXISTS idx_gcal_sync_runs_created ON gcal_sync_runs (created_at DESC);
