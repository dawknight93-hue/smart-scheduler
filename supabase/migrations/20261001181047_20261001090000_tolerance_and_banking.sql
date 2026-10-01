ALTER TABLE goal_measures ADD COLUMN IF NOT EXISTS tolerance numeric;
ALTER TABLE goal_measures ADD COLUMN IF NOT EXISTS bankable boolean NOT NULL DEFAULT false;