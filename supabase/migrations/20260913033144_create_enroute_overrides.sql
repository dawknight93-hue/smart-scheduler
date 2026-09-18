/*
# Create enroute_overrides table (Calendar Hygiene — manual boundary locks)

When the Calendar Hygiene feature auto-generates Enroute drive-time blocks
for a flight, it may later need to recheck or slide those blocks if the
flight time changes. This table records which boundaries the user has
manually adjusted (moved, resized, or deleted the enroute_block for), so
that any future automated recheck leaves those boundaries alone.

A row's presence = "this boundary (this flight + this direction) is
locked from automatic changes." Deleting the row resets it to automatic.

## New Tables

### enroute_overrides
- id (uuid, primary key)
- flight_id (uuid, foreign key → fixed_events.id, ON DELETE CASCADE)
  — The flight whose enroute boundary was manually adjusted. When the
    flight is deleted, its override records are automatically removed.
- direction (text, not null, CHECK in ('to','from'))
  — Matches the direction values used in enroute_blocks:
    'to' = drive-to-the-airport boundary (before departure)
    'from' = drive-home boundary (after arrival)
- created_at (timestamptz, not null, default now())

## Constraints
- UNIQUE (flight_id, direction) — only one override per flight+direction
  combination. You can't lock the same boundary twice.

## Security
- RLS enabled on enroute_overrides.
- All tables allow anon + authenticated full CRUD (single-tenant, no sign-in).
- USING (true) is acceptable because the data is intentionally shared/public
  for this personal single-user app with no authentication.
*/

CREATE TABLE IF NOT EXISTS enroute_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_id uuid NOT NULL REFERENCES fixed_events(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('to', 'from')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flight_id, direction)
);

ALTER TABLE enroute_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_enroute_overrides" ON enroute_overrides;
CREATE POLICY "anon_select_enroute_overrides" ON enroute_overrides FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_enroute_overrides" ON enroute_overrides;
CREATE POLICY "anon_insert_enroute_overrides" ON enroute_overrides FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_enroute_overrides" ON enroute_overrides;
CREATE POLICY "anon_update_enroute_overrides" ON enroute_overrides FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_enroute_overrides" ON enroute_overrides;
CREATE POLICY "anon_delete_enroute_overrides" ON enroute_overrides FOR DELETE
  TO anon, authenticated USING (true);
