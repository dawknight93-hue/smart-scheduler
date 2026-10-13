/**
 * Plan a day: type a messy list, let the AI fill in the details, preview where
 * the planner puts each task on the real calendar, then lock it in.
 *
 * While previewing, the tasks exist only here (as app-only Task objects with a
 * "plan:" id) and are drawn as dashed "proposed" blocks. Locking in saves them
 * as ordinary tasks: fixed ones pinned to their time, flexible ones with the
 * whole day as their window. What didn't fit is saved with the day as its
 * window, so it shows up in the "not on your calendar" list for you to place.
 */
import { supabase } from "./supabase";
import { appSettings } from "./appSettings";
import { homeDate } from "./schedulingEngine";
import { PILLARS, PILLAR_LABELS, type ContextTag, type LifePillar, type Task } from "./types";

export const PLAN_PREFIX = "plan:";
/** Breathing room after each planned task (preview only; locked tasks keep the gaps). */
export const PLAN_BUFFER_MIN = 10;

export type Effort = "focus" | "routine" | "light";

export interface DraftTask {
  key: string;
  name: string;
  tier: number;
  duration_min: number;
  effort: Effort;
  pillar: LifePillar | null;
  context: ContextTag;
  /** "HH:MM" limits for that day (e.g. lesson prep due before the lesson). */
  not_before: string | null;
  due_by: string | null;
  note: string | null;
  /** Locked in at its planned time (default) or left for the planner to move during the day. */
  flexible: boolean;
  /** You dragged it here in the preview. */
  pin: { start: string; end: string } | null;
}

export interface PlanDraft {
  day: string; // YYYY-MM-DD
  text: string;
  tasks: DraftTask[];
  stage: "input" | "preview";
}

const DRAFT_KEY = "smartScheduler.planDraft";

export function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function emptyDraft(day = todayKey()): PlanDraft {
  return { day, text: "", tasks: [], stage: "input" };
}

export function loadDraft(): PlanDraft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const d = JSON.parse(raw) as PlanDraft;
      // A draft for a day that's already over starts fresh.
      if (d && typeof d.day === "string" && d.day >= todayKey() && Array.isArray(d.tasks)) return d;
    }
  } catch {
    /* no saved draft */
  }
  return emptyDraft();
}

export function saveDraft(d: PlanDraft): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* storage unavailable: the draft just isn't kept */
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* nothing to clear */
  }
}

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y, m - 1, d];
}

function at(day: string, hhmm: string): Date {
  const [y, m, d] = parts(day);
  const [h, mi] = hhmm.split(":").map(Number);
  return homeDate(y, m, d, h, mi);
}

/** The part of the day tasks can go in: after quiet hours end (or now, today) until quiet hours start. */
export function dayWindow(day: string, now = new Date()): { start: Date; end: Date } {
  const [y, m, d] = parts(day);
  let start = homeDate(y, m, d, appSettings.quietEndHour, 0);
  const end = homeDate(y, m, d, appSettings.quietStartHour, 0);
  if (now > start) {
    // Today: from the next quarter hour.
    const q = 15 * 60000;
    start = new Date(Math.ceil(now.getTime() / q) * q);
  }
  return { start, end };
}

/** The window a draft task may use: the day, narrowed by its own limits. */
export function taskWindow(t: DraftTask, day: string, now = new Date()): { start: Date; end: Date } {
  const w = dayWindow(day, now);
  let start = w.start;
  let end = w.end;
  if (t.not_before) start = new Date(Math.max(start.getTime(), at(day, t.not_before).getTime()));
  if (t.due_by) end = new Date(Math.min(end.getTime(), at(day, t.due_by).getTime()));
  return { start, end };
}

/** App-only Task objects for the planner (never saved). */
export function previewTasks(draft: PlanDraft, now = new Date(), unpadded: Set<string> = new Set()): Task[] {
  return draft.tasks.map((t) => {
    const buffer = unpadded.has(t.key) ? 0 : PLAN_BUFFER_MIN;
    const padded = t.duration_min + buffer;
    let start: Date;
    let end: Date;
    if (t.pin) {
      start = new Date(t.pin.start);
      end = new Date(start.getTime() + padded * 60000);
    } else {
      const w = taskWindow(t, draft.day, now);
      start = w.start;
      // Room for the buffer after it, even at the very end of its window.
      end = new Date(w.end.getTime() + buffer * 60000);
    }
    return {
      id: PLAN_PREFIX + t.key,
      name: t.name,
      tier: t.tier,
      duration_min: padded,
      search_start: start.toISOString(),
      deadline: end.toISOString(),
      context: t.context,
      pillar: t.pillar,
      effort: t.effort,
      effort_auto: false,
      completed_at: null,
      no_batch: true,
    };
  });
}

export function newKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/briefing`;

/** Asks the AI to turn the list into tasks. `events` are that day's calendar entries ("09:30–10:00 FAA Medical"). */
export async function readListWithAi(text: string, day: string, events: string[]): Promise<DraftTask[]> {
  const roles = PILLARS.map((k) => ({ key: k, label: PILLAR_LABELS[k] }));
  const resp = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "parse-tasks",
      text,
      day: new Date(at(day, "12:00")).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
      roles,
      events,
      about: appSettings.aboutMe ?? "",
      quiet: `${String(appSettings.quietStartHour).padStart(2, "0")}:00–${String(appSettings.quietEndHour).padStart(2, "0")}:00`,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) throw new Error(data.error ?? `The AI couldn't read the list (${resp.status}).`);
  return ((data.tasks ?? []) as Omit<DraftTask, "key" | "flexible" | "pin">[]).map((t) => ({
    ...t,
    pillar: (t.pillar as LifePillar | null) ?? null,
    key: newKey(),
    flexible: false,
    pin: null,
  }));
}

/** Saves the plan as real tasks. `placed` maps a draft key to where the preview put it. */
export async function lockInPlan(
  draft: PlanDraft,
  placed: Map<string, { start: Date }>,
  now = new Date()
): Promise<{ fixed: number; flexible: number; toList: number }> {
  const rows: Record<string, unknown>[] = [];
  let fixed = 0;
  let flexible = 0;
  let toList = 0;
  for (const t of draft.tasks) {
    const spot = placed.get(t.key);
    const w = taskWindow(t, draft.day, now);
    let start: Date;
    let end: Date;
    if (spot && !t.flexible) {
      start = spot.start;
      end = new Date(spot.start.getTime() + t.duration_min * 60000);
      fixed++;
    } else {
      // Flexible, or didn't fit: the day is its window. One that didn't fit waits in your list.
      start = w.start;
      end = w.end;
      if (spot) flexible++;
      else toList++;
    }
    rows.push({
      name: t.name,
      tier: t.tier,
      duration_min: t.duration_min,
      search_start: start.toISOString(),
      deadline: end.toISOString(),
      context: t.context,
      pillar: t.pillar,
      effort: t.effort,
      effort_auto: false,
      recurrence_enabled: false,
    });
  }
  if (rows.length) {
    const { error } = await supabase.from("tasks").insert(rows);
    if (error) throw new Error(error.message);
  }
  return { fixed, flexible, toList };
}
