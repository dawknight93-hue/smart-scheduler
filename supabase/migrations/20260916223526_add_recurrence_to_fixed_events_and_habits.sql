/*
# Add recurrence support to Fixed Events and Habits + create occurrence tables

## Overview
Extends the recurrence system (currently only on Tasks) to also cover
Fixed Events and Habits, mirroring Google Calendar's recurring-event model:
a parent record holds the recurrence rule; individual occurrences are virtual
and only become real rows when someone touches one (delete, override, complete).

## 1. Modified Tables

### fixed_events — adds the same 11 recurrence columns that tasks already has:
- recurrence_enabled boolean default false
- recurrence_frequency text — 'daily', 'weekly', or 'monthly'
- recurrence_interval int — every N days/weeks/months
- recurrence_weekdays int[] — 0=Sun..6=Sat (weekly only)
- recurrence_monthly_mode text — 'day_of_month' or 'weekday_of_month'
- recurrence_monthly_day int — 1-31 (day_of_month mode)
- recurrence_monthly_week_n int — 1=first..4=fourth, -1=last (weekday_of_month)
- recurrence_monthly_weekday int — 0-6 (weekday_of_month)
- recurrence_end_mode text — 'never', 'on_date', or 'after_count'
- recurrence_end_date timestamptz — end date (on_date mode)
- recurrence_count int — total occurrences (after_count mode)

### habits — adds the same 11 recurrence columns

## 2. New Tables

### fixed_event_occurrences — mirrors task_occurrences for fixed events
- id (uuid, primary key)
- item_id (uuid, FK to fixed_events, ON DELETE CASCADE)
- occurrence_date (date, not null)
- completed (boolean, default false)
- completed_at (timestamptz, nullable)
- override_start (timestamptz, nullable) — set when dragged to a different time
- override_end (timestamptz, nullable)
- skipped (boolean, default false) — set when deleted
- created_at (timestamptz, default now())
- UNIQUE(item_id, occurrence_date)

### habit_occurrences — mirrors task_occurrences for habits
- id (uuid, primary key)
- item_id (uuid, FK to habits, ON DELETE CASCADE)
- occurrence_date (date, not null)
- completed (boolean, default false)
- completed_at (timestamptz, nullable)
- override_start (timestamptz, nullable)
- override_end (timestamptz, nullable)
- skipped (boolean, default false)
- created_at (timestamptz, default now())
- UNIQUE(item_id, occurrence_date)

## 3. Security
- RLS enabled on both new occurrence tables.
- Allow anon + authenticated full CRUD (single-tenant, no auth, same as all other tables).
*/

-- Add recurrence columns to fixed_events
ALTER TABLE fixed_events
  ADD COLUMN IF NOT EXISTS recurrence_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recurrence_frequency text,
  ADD COLUMN IF NOT EXISTS recurrence_interval int,
  ADD COLUMN IF NOT EXISTS recurrence_weekdays int[],
  ADD COLUMN IF NOT EXISTS recurrence_monthly_mode text,
  ADD COLUMN IF NOT EXISTS recurrence_monthly_day int,
  ADD COLUMN IF NOT EXISTS recurrence_monthly_week_n int,
  ADD COLUMN IF NOT EXISTS recurrence_monthly_weekday int,
  ADD COLUMN IF NOT EXISTS recurrence_end_mode text,
  ADD COLUMN IF NOT EXISTS recurrence_end_date timestamptz,
  ADD COLUMN IF NOT EXISTS recurrence_count int;

-- Add recurrence columns to habits
ALTER TABLE habits
  ADD COLUMN IF NOT EXISTS recurrence_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recurrence_frequency text,
  ADD COLUMN IF NOT EXISTS recurrence_interval int,
  ADD COLUMN IF NOT EXISTS recurrence_weekdays int[],
  ADD COLUMN IF NOT EXISTS recurrence_monthly_mode text,
  ADD COLUMN IF NOT EXISTS recurrence_monthly_day int,
  ADD COLUMN IF NOT EXISTS recurrence_monthly_week_n int,
  ADD COLUMN IF NOT EXISTS recurrence_monthly_weekday int,
  ADD COLUMN IF NOT EXISTS recurrence_end_mode text,
  ADD COLUMN IF NOT EXISTS recurrence_end_date timestamptz,
  ADD COLUMN IF NOT EXISTS recurrence_count int;

-- Create fixed_event_occurrences table
CREATE TABLE IF NOT EXISTS fixed_event_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES fixed_events(id) ON DELETE CASCADE,
  occurrence_date date NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  override_start timestamptz,
  override_end timestamptz,
  skipped boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(item_id, occurrence_date)
);

ALTER TABLE fixed_event_occurrences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_fixed_event_occurrences" ON fixed_event_occurrences;
CREATE POLICY "anon_select_fixed_event_occurrences" ON fixed_event_occurrences FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_fixed_event_occurrences" ON fixed_event_occurrences;
CREATE POLICY "anon_insert_fixed_event_occurrences" ON fixed_event_occurrences FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_fixed_event_occurrences" ON fixed_event_occurrences;
CREATE POLICY "anon_update_fixed_event_occurrences" ON fixed_event_occurrences FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_fixed_event_occurrences" ON fixed_event_occurrences;
CREATE POLICY "anon_delete_fixed_event_occurrences" ON fixed_event_occurrences FOR DELETE
  TO anon, authenticated USING (true);

-- Create habit_occurrences table
CREATE TABLE IF NOT EXISTS habit_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  occurrence_date date NOT NULL,
  completed boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  override_start timestamptz,
  override_end timestamptz,
  skipped boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE(item_id, occurrence_date)
);

ALTER TABLE habit_occurrences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_habit_occurrences" ON habit_occurrences;
CREATE POLICY "anon_select_habit_occurrences" ON habit_occurrences FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_habit_occurrences" ON habit_occurrences;
CREATE POLICY "anon_insert_habit_occurrences" ON habit_occurrences FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_habit_occurrences" ON habit_occurrences;
CREATE POLICY "anon_update_habit_occurrences" ON habit_occurrences FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_habit_occurrences" ON habit_occurrences;
CREATE POLICY "anon_delete_habit_occurrences" ON habit_occurrences FOR DELETE
  TO anon, authenticated USING (true);
