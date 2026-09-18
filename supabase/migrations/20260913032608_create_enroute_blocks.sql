/*
# Create enroute_blocks table (Calendar Hygiene — drive-time blocks)

This migration adds schema support for "Enroute" blocks — auto-generated
drive-time events tied to a flight. When a flight exists as a fixed_event,
the Calendar Hygiene feature will compute the drive time to/from the airport
and create an enroute_block representing that travel window. These blocks
appear on the calendar like fixed events so the user can see the full
door-to-door time commitment of a flight.

This is a SCHEMA-ONLY migration. No UI, scheduling logic, or automation
is added in this step.

## New Tables

### enroute_blocks
- id (uuid, primary key)
- flight_id (uuid, foreign key → fixed_events.id, ON DELETE CASCADE)
  — The flight this enroute block is tied to. When the flight is deleted,
    its enroute blocks are automatically removed.
- name (text, not null) — Human-readable label, e.g. "Drive to airport"
- direction (text, not null, CHECK in ('to','from'))
  — 'to' = drive to the airport before the flight departs
  — 'from' = drive from the airport after the flight arrives
- start_time (timestamptz, not null) — When the drive begins
- end_time (timestamptz, not null) — When the drive ends (arrival at
  airport for 'to', arrival at final destination for 'from')
- drive_duration_min (int, not null) — Estimated drive time in minutes,
  stored separately from start/end so it survives even if the block
  is later shifted or adjusted.
- created_at (timestamptz, default now())

## Indexes
- idx_enroute_blocks_flight_id on (flight_id) — fast lookup of all
  enroute blocks for a given flight.

## Security
- RLS enabled on enroute_blocks.
- All tables allow anon + authenticated full CRUD (single-tenant, no sign-in).
- USING (true) is acceptable because the data is intentionally shared/public
  for this personal single-user app with no authentication.
*/

CREATE TABLE IF NOT EXISTS enroute_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_id uuid NOT NULL REFERENCES fixed_events(id) ON DELETE CASCADE,
  name text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('to', 'from')),
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  drive_duration_min int NOT NULL,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE enroute_blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_enroute_blocks" ON enroute_blocks;
CREATE POLICY "anon_select_enroute_blocks" ON enroute_blocks FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_enroute_blocks" ON enroute_blocks;
CREATE POLICY "anon_insert_enroute_blocks" ON enroute_blocks FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_enroute_blocks" ON enroute_blocks;
CREATE POLICY "anon_update_enroute_blocks" ON enroute_blocks FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_enroute_blocks" ON enroute_blocks;
CREATE POLICY "anon_delete_enroute_blocks" ON enroute_blocks FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_enroute_blocks_flight_id ON enroute_blocks(flight_id);
