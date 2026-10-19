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