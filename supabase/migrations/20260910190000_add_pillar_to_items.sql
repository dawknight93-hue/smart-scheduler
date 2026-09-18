/*
  # Add pillar column to habits, tasks, and fixed_events

  1. Modified Tables
    - `habits`
      - Adds `pillar` (text, nullable) - which of the 7 life pillars
        (spiritual, family, mil_career, civ_career, financial, physical, mental)
        this habit belongs to. Default NULL (unassigned).
    - `tasks`
      - Adds `pillar` (text, nullable) - same meaning as above.
    - `fixed_events`
      - Adds `pillar` (text, nullable) - same meaning as above. Google-synced
        events default to NULL and are tagged manually after sync.
  2. Security
    - No policy changes needed; existing anon+authenticated CRUD policies
      already cover the new column.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'habits' AND column_name = 'pillar'
  ) THEN
    ALTER TABLE habits ADD COLUMN pillar text;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'pillar'
  ) THEN
    ALTER TABLE tasks ADD COLUMN pillar text;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fixed_events' AND column_name = 'pillar'
  ) THEN
    ALTER TABLE fixed_events ADD COLUMN pillar text;
  END IF;
END $$;
