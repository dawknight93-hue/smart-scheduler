/*
  # Strava connection (finished runs)

  1. New table
    - `strava_tokens` (one row): the Strava sign-in for this copy of the app —
      access and refresh tokens, who connected, and the last sync result.
  2. Security
    - RLS on with no policies: only the server function (service role) can
      read or write it; the app never sees the tokens.
  3. Schema version
*/
CREATE TABLE IF NOT EXISTS strava_tokens (
  id integer PRIMARY KEY DEFAULT 1,
  athlete_id bigint,
  athlete_name text,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_sync_at timestamptz,
  last_sync_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE strava_tokens ENABLE ROW LEVEL SECURITY;

UPDATE schema_meta SET version = 20261019120000 WHERE id = 1;
