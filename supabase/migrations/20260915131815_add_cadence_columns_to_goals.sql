ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS cadence_sessions_per_week integer,
  ADD COLUMN IF NOT EXISTS cadence_label text,
  ADD COLUMN IF NOT EXISTS cadence_confirmed boolean NOT NULL DEFAULT false;
