/*
# Briefing memory

Corrections and preferences for the written Briefing summary. Every active note
is sent with each summary request, so the summary "learns" from what you tell
it (thumbs-down + note, or added in the Memory panel). Nothing here changes the
model itself.

- note: the correction in your words.
- active: switch a note off without deleting it.
- source: 'feedback' (from a thumbs-down), 'manual', or 'seed' (the first set,
  taken from Section A testing).
- excerpt: the summary text you were reacting to (for context in the panel).

Single-tenant RLS (anon, USING true), matching every other table in this app.
*/

CREATE TABLE IF NOT EXISTS briefing_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('feedback', 'manual', 'seed')),
  kind text,
  excerpt text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE briefing_memory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_briefing_memory" ON briefing_memory;
CREATE POLICY "anon_select_briefing_memory" ON briefing_memory FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_briefing_memory" ON briefing_memory;
CREATE POLICY "anon_insert_briefing_memory" ON briefing_memory FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_briefing_memory" ON briefing_memory;
CREATE POLICY "anon_update_briefing_memory" ON briefing_memory FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_briefing_memory" ON briefing_memory;
CREATE POLICY "anon_delete_briefing_memory" ON briefing_memory FOR DELETE
  TO anon, authenticated USING (true);
