/*
# Awareness rules (Briefing tab)

Rules that turn events on info-only calendars into Situational awareness notes.
You edit them in the Briefing tab (Rules button); the app seeds sensible
defaults the first time it finds the table empty.

- match: comma-separated words/phrases; any one found in the event title matches
  (empty = any title, only with a calendar filter in `source`).
- source: optional calendar-name filter (e.g. 'jatara').
- tone: duty | money | family | info (the icon in the card).
- role: reserve | proffer | assignments for the three rules that work together
  on reserve days; NULL for everything else.
- note / action: wording on the event's day; note_next / action_next: the day
  before; coming_up + lead_days: listed in "Coming up" that many days ahead.
- confirm_by / assign_from: reserve rule times (HH:MM).

Single-tenant RLS (anon, USING true), matching every other table in this app.
*/

CREATE TABLE IF NOT EXISTS awareness_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position integer NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT true,
  label text NOT NULL DEFAULT '',
  match text NOT NULL DEFAULT '',
  source text,
  tone text NOT NULL DEFAULT 'info' CHECK (tone IN ('duty', 'money', 'family', 'info')),
  role text CHECK (role IN ('reserve', 'proffer', 'assignments')),
  note text NOT NULL DEFAULT '',
  action text,
  note_next text,
  action_next text,
  lead_days integer NOT NULL DEFAULT 0,
  coming_up text,
  confirm_by text,
  assign_from text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE awareness_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_awareness_rules" ON awareness_rules;
CREATE POLICY "anon_select_awareness_rules" ON awareness_rules FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_awareness_rules" ON awareness_rules;
CREATE POLICY "anon_insert_awareness_rules" ON awareness_rules FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_awareness_rules" ON awareness_rules;
CREATE POLICY "anon_update_awareness_rules" ON awareness_rules FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_awareness_rules" ON awareness_rules;
CREATE POLICY "anon_delete_awareness_rules" ON awareness_rules FOR DELETE
  TO anon, authenticated USING (true);
