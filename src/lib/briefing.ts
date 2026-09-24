/**
 * Briefing data: daily, weekly and monthly. Everything here is computed from
 * the same sources the calendar uses (scheduler output, Google-pulled events,
 * Enroute blocks, goals) so the briefing never disagrees with the calendar.
 */
import { supabase } from "./supabase";
import { addDays, getWeekStart, runEngine, utaRanges, WORK_START_HOUR, WORK_END_HOUR } from "./schedulingEngine";
import { HOME_AIRPORT, parseFlightLeg, type StoredEnrouteBlock } from "./calendarHygiene";
import { formatLocalDate } from "./recurrence";
import {
  PLAN_GOAL_COLUMNS,
  countGoalEvents,
  goalShortName,
  loadWeekData,
  sortByPriority,
  verifyWeek,
  type PlanGoal,
  type WeekData,
  type WeekReviewRow,
} from "./goalPlanning";
import { goalDayEntries, loadDailyItems, type DailyItem, type DayEntry } from "./goalDaily";
import type { LifePillar, Task, UnscheduledItem } from "./types";

export type BriefingKind = "daily" | "weekly" | "monthly";

const DAY = 24 * 3600 * 1000;
export const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
export const dayLabel = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
/** All-day events are stored at UTC midnight of their date. */
const allDayDate = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export function defaultBriefingKind(now = new Date()): BriefingKind {
  const lastDayOfMonth = addDays(startOfDay(now), 1).getDate() === 1;
  if (lastDayOfMonth) return "monthly";
  if (now.getDay() === 0 && (now.getHours() > 21 || (now.getHours() === 21 && now.getMinutes() >= 30))) return "weekly";
  return "daily";
}

// ---------------------------------------------------------------------------
// Shared: what's on the calendar in a range

export interface BriefItem {
  id: string;
  name: string;
  kind: string;
  /** False for display-only calendars (Informational, Jatara's) — shown, never holds time. */
  blocks?: boolean;
  start: Date;
  end: Date;
  allDay: boolean;
  pillar: LifePillar | null;
  flight?: { origin: string; destination: string };
  enroute?: "to" | "from";
  goalSession?: boolean;
}

interface RangeData {
  items: BriefItem[];
  unscheduled: UnscheduledItem[];
  weeks: WeekData[];
  tasks: Task[];
}

async function loadRange(start: Date, end: Date): Promise<RangeData> {
  const weekStarts: Date[] = [];
  for (let w = getWeekStart(start); w < end; w = addDays(w, 7)) weekStarts.push(w);
  const [weeks, eb, tk] = await Promise.all([
    Promise.all(weekStarts.map((w) => loadWeekData(w))),
    supabase.from("enroute_blocks").select("*").lt("start_time", end.toISOString()).gt("end_time", start.toISOString()),
    supabase.from("tasks").select("*"),
  ]);
  const items: BriefItem[] = [];
  const unscheduled: UnscheduledItem[] = [];
  const seenAllDay = new Set<string>();
  for (const week of weeks) {
    const goalHabitIds = new Set(week.habits.filter((h) => h.goal_id).map((h) => h.id));
    const r = runEngine(week.weekStart, week.busy, week.habits, week.tasks);
    unscheduled.push(...r.unscheduled);
    for (const p of r.placed) {
      if (p.isAllDay) continue; // handled below with their real calendar dates
      if (p.end <= start || p.start >= end) continue;
      const fe = week.fixedById.get(p.id);
      const leg = fe ? parseFlightLeg(fe) : null;
      items.push({
        id: `${p.id}-${p.start.getTime()}`,
        name: p.name,
        kind: p.kind,
        start: p.start,
        end: p.end,
        allDay: false,
        pillar: p.pillar ?? null,
        flight: leg ? { origin: leg.origin, destination: leg.destination } : undefined,
        goalSession: goalHabitIds.has(p.id),
        blocks: p.blocksSchedule !== false,
      });
    }
    for (const e of week.busy.filter((x) => x.is_all_day)) {
      if (seenAllDay.has(e.id)) continue;
      const s = allDayDate(e.start_time);
      const en = allDayDate(e.end_time);
      if (en <= start || s >= end) continue;
      seenAllDay.add(e.id);
      items.push({ id: e.id, name: e.name, kind: "Fixed Event", start: s, end: en, allDay: true, pillar: e.pillar ?? null });
    }
  }
  for (const b of (eb.data as StoredEnrouteBlock[]) ?? []) {
    items.push({
      id: `enroute-${b.id}`,
      name: `🚗 ${b.name}`,
      kind: "Enroute",
      start: new Date(b.start_time),
      end: new Date(b.end_time),
      allDay: false,
      pillar: "civ_career",
      enroute: b.direction,
    });
  }
  items.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { items, unscheduled, weeks, tasks: (tk.data as Task[]) ?? [] };
}

async function loadGoals(): Promise<PlanGoal[]> {
  const { data } = await supabase.from("goals").select(PLAN_GOAL_COLUMNS);
  return (data as PlanGoal[]) ?? [];
}

function dayItems(items: BriefItem[], day: Date) {
  const s = startOfDay(day);
  const e = addDays(s, 1);
  return items.filter((i) => i.start < e && i.end > s);
}

// ---------------------------------------------------------------------------
// Weather stops for flights

export interface WeatherStop {
  iata: string;
  from: string;
  to: string;
}

export interface WeatherResult extends WeatherStop {
  icao?: string;
  tz?: string;
  error?: string;
  taf?: string;
  metar?: string;
  forecast: null | {
    condition: string;
    code: number;
    tempMinF: number | null;
    tempMaxF: number | null;
    windKt: number;
    gustKt: number;
    precipPct: number;
    visSm: number | null;
    cloudPct: number;
  };
}

/**
 * Where he'll be and when: an hour before each departure at the origin, and
 * from landing until the next departure from the same airport (or an hour
 * after landing if the trip continues elsewhere / ends).
 */
export function weatherStops(items: BriefItem[]): WeatherStop[] {
  const legs = items.filter((i) => i.flight).sort((a, b) => a.start.getTime() - b.start.getTime());
  const stops: WeatherStop[] = [];
  legs.forEach((leg, i) => {
    const f = leg.flight!;
    stops.push({ iata: f.origin, from: new Date(leg.start.getTime() - 3600000).toISOString(), to: leg.start.toISOString() });
    const next = legs[i + 1];
    // Away from base, cover the whole layover; at home, just the hour after landing.
    const layover = next && f.destination !== HOME_AIRPORT && next.flight!.origin === f.destination && next.start.getTime() - leg.end.getTime() < 20 * 3600000;
    const stayUntil = layover ? next.start : new Date(leg.end.getTime() + 3600000);
    stops.push({ iata: f.destination, from: leg.end.toISOString(), to: stayUntil.toISOString() });
  });
  // Merge back-to-back stops at the same airport (a turn: land, then depart again).
  const merged: WeatherStop[] = [];
  for (const s of stops) {
    const last = merged[merged.length - 1];
    if (last && last.iata === s.iata && Date.parse(s.from) <= Date.parse(last.to) + 60000) {
      last.to = new Date(Math.max(Date.parse(last.to), Date.parse(s.to))).toISOString();
    } else merged.push({ ...s });
  }
  return merged;
}

const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/briefing`;
const HEADERS = { Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`, "Content-Type": "application/json" };

async function callBriefing<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(FUNCTION_URL, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export async function fetchWeather(stops: WeatherStop[]): Promise<WeatherResult[]> {
  if (!stops.length) return [];
  const { stops: out } = await callBriefing<{ stops: WeatherResult[] }>({ action: "weather", stops });
  return out;
}

export async function fetchSummary(kind: BriefingKind, facts: string): Promise<string> {
  const { summary } = await callBriefing<{ summary: string }>({ action: "summary", kind, facts });
  return summary;
}

// ---------------------------------------------------------------------------
// Goal progress

export interface GoalProgress {
  goal: PlanGoal;
  target: number;
  /** Sessions ticked done this week (Daily level). */
  done: number;
  /** Sessions whose time has already come this week. */
  past: number;
  scheduled: number;
  /** Today's sessions with their focus. */
  today: DayEntry[];
  /** Earlier sessions this week that were never ticked done. */
  unticked: DayEntry[];
  nextCheckpoint: { title: string; due: string; daysLeft: number } | null;
  deadlineDays: number | null;
}

function goalProgress(goals: PlanGoal[], week: WeekData | undefined, now: Date, items: DailyItem[]): GoalProgress[] {
  if (!week) return [];
  const planned = sortByPriority(goals.filter((g) => g.status === "active" && g.plan_mode && (g.cadence_sessions_per_week ?? 0) > 0));
  const r = runEngine(week.weekStart, week.busy, week.habits, week.tasks);
  const placedById = new Map(r.placed.map((p) => [p.id, p]));
  const today = startOfDay(now);
  return planned.map((g) => {
    const sessions = week.habits
      .filter((h) => h.goal_id === g.id && new Date(h.search_start) >= week.weekStart && new Date(h.search_start) < week.weekEnd)
      .map((h) => {
        const p = placedById.get(h.id);
        return { id: h.id, start: p?.start ?? new Date(h.search_start), end: p?.end ?? new Date(h.search_end) };
      });
    const entries = goalDayEntries(g, sessions, g.plan_mode === "count" ? countGoalEvents(g, week) : [], items);
    const isPast = (e: DayEntry) => (e.start ?? addDays(e.day, 1)) <= now;
    const next = (g.milestones ?? []).filter((m) => !m.done && new Date(`${m.due}T23:59:00`) >= today).sort((a, b) => a.due.localeCompare(b.due))[0];
    return {
      goal: g,
      target: g.cadence_sessions_per_week ?? 0,
      done: entries.filter((e) => e.done).length,
      past: entries.filter(isPast).length,
      scheduled: entries.length,
      today: entries.filter((e) => e.day.getTime() === today.getTime()),
      unticked: entries.filter((e) => !e.done && e.day < today),
      nextCheckpoint: next ? { title: next.title, due: next.due, daysLeft: Math.round((new Date(`${next.due}T00:00:00`).getTime() - today.getTime()) / DAY) } : null,
      deadlineDays: g.deadline ? Math.round((startOfDay(new Date(g.deadline)).getTime() - today.getTime()) / DAY) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Daily

export interface DailyBriefing {
  kind: "daily";
  date: Date;
  agenda: BriefItem[];
  allDay: BriefItem[];
  utaToday: boolean;
  utaTomorrow: boolean;
  flightsToday: BriefItem[];
  weatherStops: WeatherStop[];
  goals: GoalProgress[];
  headsUp: string[];
  tomorrow: { first: BriefItem | null; leaveBy: BriefItem | null; firstFlight: BriefItem | null; flights: BriefItem[]; earlyStart: boolean };
}

/** Counts toward your time: not an info-only item from a display-only calendar (flights always count). */
const holdsTime = (i: BriefItem) => i.blocks !== false || !!i.flight;

export async function buildDaily(now = new Date()): Promise<DailyBriefing> {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const weekStart = getWeekStart(today);
  const [range, goalRows, dailyItems] = await Promise.all([
    loadRange(today, addDays(today, 2)),
    loadGoals(),
    loadDailyItems(weekStart, addDays(weekStart, 7)).catch(() => [] as DailyItem[]),
  ]);
  const todayItems = dayItems(range.items, today);
  const tomorrowItems = dayItems(range.items, tomorrow);
  const allFixed = range.weeks.flatMap((w) => w.busy);
  const uta = utaRanges(allFixed);
  const isUta = (d: Date) => uta.some(([a, b]) => d.getTime() + 12 * 3600000 >= a.getTime() && d.getTime() + 12 * 3600000 < b.getTime());

  const headsUp: string[] = [];
  // Overdue one-time tasks
  for (const t of range.tasks.filter((x) => !x.recurrence_enabled && !x.completed_at && new Date(x.deadline) < now)) {
    headsUp.push(`Overdue: ${t.name} (was due ${relDay(new Date(t.deadline), now)} at ${hhmm(new Date(t.deadline))})`);
  }
  // Items the scheduler couldn't place this week
  const trayed = new Map<string, UnscheduledItem>();
  for (const u of range.unscheduled) {
    const task = range.tasks.find((t) => t.id === u.id);
    if (u.kind === "Task" && task?.completed_at) continue;
    if (u.deadline < today) continue;
    trayed.set(u.id, u);
  }
  for (const u of trayed.values()) headsUp.push(`Not on the calendar: ${u.name} (${u.kind.toLowerCase()})`);
  // Overlapping timed commitments today
  const timed = todayItems.filter((i) => !i.allDay && i.kind === "Fixed Event" && i.blocks !== false);
  for (let i = 0; i < timed.length; i++)
    for (let j = i + 1; j < timed.length; j++)
      if (timed[j].start < timed[i].end && timed[i].start < timed[j].end)
        headsUp.push(`Conflict: ${timed[i].name} ${hhmm(timed[i].start)} overlaps ${timed[j].name} ${hhmm(timed[j].start)}`);
  // Tight turnaround: less than an hour between getting home from a trip and the next commitment
  for (const home of [...todayItems, ...tomorrowItems].filter((i) => i.enroute === "from")) {
    const nextUp = [...todayItems, ...tomorrowItems].find((i) => !i.allDay && !i.enroute && !i.flight && holdsTime(i) && i.start >= home.start && i.start.getTime() - home.end.getTime() < 3600000);
    if (nextUp) headsUp.push(`Tight turnaround: home ~${hhmm(home.end)}, then ${nextUp.name} at ${hhmm(nextUp.start)}`);
  }
  const goals = goalProgress(goalRows, range.weeks.find((w) => w.weekStart.getTime() === weekStart.getTime()), now, dailyItems);
  // Earlier goal sessions this week nobody ticked done
  for (const g of goals) {
    if (g.unticked.length)
      headsUp.push(
        `Not ticked done: ${g.unticked.map((e) => `${dayLabel(e.day)} ${e.focus ?? e.title}`).join("; ")} (${goalShortName(g.goal)}) — did ${g.unticked.length === 1 ? "it" : "they"} happen?`
      );
  }
  if (isUta(today)) headsUp.unshift("UTA today — Family, Desk, Home and Errand items are kept off the calendar.");
  else if (isUta(tomorrow)) headsUp.push("UTA tomorrow.");

  const tomorrowTimed = tomorrowItems.filter((i) => !i.allDay && holdsTime(i));
  const firstFlight = tomorrowTimed.find((i) => i.flight) ?? null;
  const leaveBy = firstFlight ? tomorrowTimed.find((i) => i.enroute === "to" && i.end <= firstFlight.start) ?? null : null;
  const first = tomorrowTimed[0] ?? null;
  const earlyStart = !!first && first.start.getHours() < 8;

  return {
    kind: "daily",
    date: today,
    agenda: todayItems.filter((i) => !i.allDay),
    allDay: todayItems.filter((i) => i.allDay),
    utaToday: isUta(today),
    utaTomorrow: isUta(tomorrow),
    flightsToday: todayItems.filter((i) => i.flight),
    weatherStops: weatherStops([...todayItems, ...tomorrowItems].filter((i) => i.flight && i.end > now)),
    goals,
    headsUp,
    tomorrow: { first, leaveBy, firstFlight, flights: tomorrowItems.filter((i) => i.flight), earlyStart },
  };
}

// ---------------------------------------------------------------------------
// Weekly / monthly

export interface PeriodLookBack {
  label: string;
  goalLines: { goal: PlanGoal; held: number; done: number; target: number; status: WeekReviewRow["status"] | null }[];
  reviewsByGoal: { goal: PlanGoal; approved: number; short: number; skipped: number }[];
  tasksCompleted: string[];
  checkpointsHit: string[];
  checkpointsMissed: string[];
}

export interface PeriodLookAhead {
  label: string;
  start: Date;
  flightDays: { date: Date; route: string }[];
  utaDays: Date[];
  busiest: { date: Date; hours: number } | null;
  deadlines: { date: Date; text: string }[];
}

export interface PeriodBriefing {
  kind: "weekly" | "monthly";
  back: PeriodLookBack;
  ahead: PeriodLookAhead;
}

function routeOfDay(items: BriefItem[]): string {
  const legs = items.filter((i) => i.flight);
  if (!legs.length) return "";
  return [legs[0].flight!.origin, ...legs.map((l) => l.flight!.destination)].join("→");
}

async function lookAhead(label: string, start: Date, end: Date, goals: PlanGoal[], withBusiest: boolean): Promise<PeriodLookAhead> {
  const range = await loadRange(start, end);
  const flightDays: { date: Date; route: string }[] = [];
  const utaDays: Date[] = [];
  const uta = utaRanges(range.weeks.flatMap((w) => w.busy));
  let busiest: { date: Date; hours: number } | null = null;
  for (let d = new Date(start); d < end; d = addDays(d, 1)) {
    const items = dayItems(range.items, d);
    const route = routeOfDay(items);
    if (route) flightDays.push({ date: new Date(d), route });
    if (uta.some(([a, b]) => d.getTime() + 12 * 3600000 >= a.getTime() && d.getTime() + 12 * 3600000 < b.getTime())) utaDays.push(new Date(d));
    if (withBusiest) {
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), WORK_START_HOUR);
      const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), WORK_END_HOUR);
      const mins = items
        .filter((i) => !i.allDay && holdsTime(i))
        .reduce((acc, i) => acc + Math.max(0, Math.min(i.end.getTime(), dayEnd.getTime()) - Math.max(i.start.getTime(), dayStart.getTime())) / 60000, 0);
      if (!busiest || mins / 60 > busiest.hours) busiest = { date: new Date(d), hours: Math.round((mins / 60) * 10) / 10 };
    }
  }
  const deadlines: { date: Date; text: string }[] = [];
  for (const t of range.tasks.filter((x) => !x.recurrence_enabled && !x.completed_at)) {
    const due = new Date(t.deadline);
    if (due >= start && due < end) deadlines.push({ date: due, text: `Task due: ${t.name}` });
  }
  for (const g of goals.filter((x) => x.status === "active")) {
    for (const m of g.milestones ?? []) {
      const due = new Date(`${m.due}T00:00:00`);
      if (!m.done && due >= start && due < end) deadlines.push({ date: due, text: `Checkpoint: ${m.title} (${goalShortName(g)})` });
    }
    if (g.deadline) {
      const d = new Date(g.deadline);
      if (d >= start && d < end) deadlines.push({ date: d, text: `Goal deadline: ${goalShortName(g)}` });
    }
  }
  deadlines.sort((a, b) => a.date.getTime() - b.date.getTime());
  return { label, start, flightDays, utaDays, busiest: busiest && busiest.hours > 0 ? busiest : null, deadlines };
}

async function lookBack(label: string, start: Date, end: Date, goals: PlanGoal[], weekly: boolean): Promise<PeriodLookBack> {
  const [rv, tk] = await Promise.all([
    supabase.from("goal_week_reviews").select("*").gte("week_start", formatLocalDate(start)).lt("week_start", formatLocalDate(end)),
    supabase.from("tasks").select("name, completed_at").gte("completed_at", start.toISOString()).lt("completed_at", end.toISOString()),
  ]);
  const reviews = (rv.data as WeekReviewRow[]) ?? [];
  const active = sortByPriority(goals.filter((g) => g.status === "active" && g.plan_mode));
  let goalLines: PeriodLookBack["goalLines"] = [];
  if (weekly) {
    const [week, items] = await Promise.all([loadWeekData(start), loadDailyItems(start, end).catch(() => [] as DailyItem[])]);
    const results = verifyWeek(active, week);
    goalLines = results.map((r) => {
      const goal = active.find((g) => g.id === r.goalId)!;
      const done = items.filter((i) => i.goal_id === r.goalId && i.done).length;
      return { goal, held: r.held, done, target: r.target, status: reviews.find((x) => x.goal_id === r.goalId)?.status ?? null };
    });
  }
  const reviewsByGoal = active.map((goal) => {
    const mine = reviews.filter((r) => r.goal_id === goal.id);
    return {
      goal,
      approved: mine.filter((r) => r.status === "approved").length,
      short: mine.filter((r) => r.status === "short").length,
      skipped: mine.filter((r) => r.status === "skipped").length,
    };
  });
  const hit: string[] = [];
  const missed: string[] = [];
  for (const g of goals) {
    for (const m of g.milestones ?? []) {
      const due = new Date(`${m.due}T00:00:00`);
      if (due >= start && due < end) (m.done ? hit : missed).push(`${m.title} (${goalShortName(g)})`);
    }
  }
  return {
    label,
    goalLines,
    reviewsByGoal,
    tasksCompleted: ((tk.data as { name: string }[]) ?? []).map((t) => t.name),
    checkpointsHit: hit,
    checkpointsMissed: missed,
  };
}

/** The week just finished (Sun → this week; otherwise last week) and the one after it. */
export async function buildWeekly(now = new Date()): Promise<PeriodBriefing> {
  const thisWeek = getWeekStart(now);
  const backStart = now.getDay() === 0 ? thisWeek : addDays(thisWeek, -7);
  const aheadStart = addDays(backStart, 7);
  const goals = await loadGoals();
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  // Mid-week, "ahead" is the rest of this week (days already gone aren't ahead).
  const today = startOfDay(now);
  const from = aheadStart < today ? today : aheadStart;
  const aheadLabel = from > aheadStart ? `rest of this week, ${fmt(from)} – ${fmt(addDays(aheadStart, 6))}` : `${fmt(aheadStart)} – ${fmt(addDays(aheadStart, 6))}`;
  const [back, ahead] = await Promise.all([
    lookBack(`${fmt(backStart)} – ${fmt(addDays(backStart, 6))}`, backStart, aheadStart, goals, true),
    lookAhead(aheadLabel, from, addDays(aheadStart, 7), goals, true),
  ]);
  return { kind: "weekly", back, ahead };
}

/** On the month's last day: this month and next. Otherwise: last month and this one. */
export async function buildMonthly(now = new Date()): Promise<PeriodBriefing> {
  const lastDay = addDays(startOfDay(now), 1).getDate() === 1;
  const backStart = lastDay ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const aheadStart = new Date(backStart.getFullYear(), backStart.getMonth() + 1, 1);
  const aheadEnd = new Date(aheadStart.getFullYear(), aheadStart.getMonth() + 1, 1);
  const goals = await loadGoals();
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const today = startOfDay(now);
  const from = aheadStart < today ? today : aheadStart;
  const [back, ahead] = await Promise.all([
    lookBack(fmt(backStart), backStart, aheadStart, goals, false),
    lookAhead(from > aheadStart ? `rest of ${fmt(aheadStart)}` : fmt(aheadStart), from, aheadEnd, goals, false),
  ]);
  return { kind: "monthly", back, ahead };
}

// ---------------------------------------------------------------------------
// Facts text for the written summary (the model only sees this)

function wxLine(w: WeatherResult): string {
  const when = `${dayLabel(new Date(w.from))} ${hhmm(new Date(w.from))}–${hhmm(new Date(w.to))}`;
  if (!w.forecast) return `${w.iata} ${when}: no forecast available`;
  const f = w.forecast;
  return `${w.iata} ${when}: ${f.condition}, ${f.tempMinF}–${f.tempMaxF}°F, wind ${f.windKt} kt gust ${f.gustKt} kt, precip chance ${f.precipPct}%${f.visSm !== null && f.visSm < 5 ? `, visibility ${f.visSm} sm` : ""}`;
}

/** "today", "yesterday", "tomorrow", or a date — so the summary never guesses relative days. */
function relDay(d: Date, now: Date): string {
  const diff = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / DAY);
  return diff === 0 ? "today" : diff === -1 ? "yesterday" : diff === 1 ? "tomorrow" : dayLabel(d);
}

export function dailyFacts(b: DailyBriefing, wx: WeatherResult[], now = new Date()): string {
  const lines = [
    `DAILY BRIEFING for ${dayLabel(b.date)}. Current time: ${hhmm(now)} on ${dayLabel(now)}. Items marked [done] are already over; only talk about what's still ahead unless something was missed.`,
  ];
  if (b.allDay.length) lines.push(`All-day: ${b.allDay.map((i) => i.name).join("; ")}`);
  lines.push(
    b.agenda.length
      ? `Agenda today (items marked [info] are reminders from an info-only calendar, not commitments or booked time): ${b.agenda.map((i) => `${hhmm(i.start)}–${hhmm(i.end)} ${i.name}${holdsTime(i) ? "" : " [info]"}${i.end <= now ? " [done]" : i.start <= now ? " [now]" : ""}`).join("; ")}`
      : "Agenda: nothing timed today."
  );
  if (wx.length) lines.push(`Airport weather: ${wx.map(wxLine).join(" | ")}`);
  if (b.goals.length) {
    lines.push(
      `Goals (session counts are sessions, NOT the goal's result; "ticked done" means he confirmed it happened): ${b.goals
        .map((g) => `goal "${goalShortName(g.goal)}": ${g.done} of ${g.target} weekly sessions ticked done (${g.past} of ${g.scheduled} on the calendar are already past)${g.nextCheckpoint ? `, next checkpoint "${g.nextCheckpoint.title}" in ${g.nextCheckpoint.daysLeft} days` : ""}`)
        .join("; ")}`
    );
    const focus = b.goals.flatMap((g) => g.today.map((e) => ({ g, e })));
    if (focus.length)
      lines.push(
        `Goal sessions today: ${focus
          .map(({ g, e }) => `${e.start ? hhmm(e.start) : "all day"} ${goalShortName(g.goal)} — ${e.focus ?? e.title}${e.done ? " [ticked done]" : ""}`)
          .join("; ")}`
      );
  }
  lines.push(b.headsUp.length ? `Heads-up: ${b.headsUp.join("; ")}` : "Heads-up: none.");
  const t = b.tomorrow;
  lines.push(
    `Tomorrow: ${t.first ? `first item ${t.first.name} at ${hhmm(t.first.start)}${t.earlyStart ? " (early start)" : ""}` : "nothing timed"}${t.firstFlight ? `; first flight ${t.firstFlight.name} at ${hhmm(t.firstFlight.start)}` : ""}${t.leaveBy ? `; leave by ${hhmm(t.leaveBy.start)}` : ""}.`
  );
  return lines.join("\n");
}

export function periodFacts(b: PeriodBriefing, now = new Date()): string {
  const k = b.kind === "weekly" ? "WEEKLY" : "MONTHLY";
  const lines = [`${k} BRIEFING. Current time: ${hhmm(now)} on ${dayLabel(now)}. Looking back at ${b.back.label}; looking ahead to ${b.ahead.label}.`];
  if (b.back.goalLines.length)
    lines.push(
      `Goal sessions held last week (session counts, NOT the goal's result — e.g. runs done, not pounds lost): ${b.back.goalLines
        .map((g) => `goal "${goalShortName(g.goal)}": ${g.held} of ${g.target} sessions on the calendar, ${g.done} ticked done${g.status ? ` (review ${g.status})` : " (week not reviewed)"}`)
        .join("; ")}`
    );
  if (b.kind === "monthly")
    lines.push(`Weekly reviews: ${b.back.reviewsByGoal.map((r) => `${goalShortName(r.goal)} ${r.approved} on target, ${r.short} short, ${r.skipped} skipped`).join("; ") || "none"}`);
  lines.push(`Tasks completed: ${b.back.tasksCompleted.length}${b.back.tasksCompleted.length ? ` (${b.back.tasksCompleted.slice(0, 8).join(", ")})` : ""}`);
  if (b.back.checkpointsHit.length) lines.push(`Checkpoints hit: ${b.back.checkpointsHit.join("; ")}`);
  if (b.back.checkpointsMissed.length) lines.push(`Checkpoints missed: ${b.back.checkpointsMissed.join("; ")}`);
  const a = b.ahead;
  lines.push(`Flying days ahead: ${a.flightDays.length}${a.flightDays.length ? ` (${a.flightDays.map((f) => `${dayLabel(f.date)} ${f.route}`).join("; ")})` : ""}`);
  lines.push(`UTA days ahead: ${a.utaDays.length ? a.utaDays.map(dayLabel).join(", ") : "none"}`);
  if (a.busiest) lines.push(`Busiest day: ${dayLabel(a.busiest.date)} with ${a.busiest.hours} hours of scheduled items (appointments, tasks and habits — not flight duty unless a flying day is listed above)`);
  lines.push("Weather is not part of this briefing; do not mention weather.");
  lines.push(`Deadlines and checkpoints ahead: ${a.deadlines.length ? a.deadlines.map((d) => `${dayLabel(d.date)} ${d.text}`).join("; ") : "none"}`);
  return lines.join("\n");
}

/** Cache key for the written summary so it's only regenerated when the facts change. */
export function factsKey(kind: BriefingKind, facts: string): string {
  let h = 0;
  for (let i = 0; i < facts.length; i++) h = (Math.imul(31, h) + facts.charCodeAt(i)) | 0;
  return `briefing-summary:${kind}:${h}`;
}

