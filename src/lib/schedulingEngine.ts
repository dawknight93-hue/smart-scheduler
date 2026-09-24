import type {
  FixedEvent,
  Habit,
  Task,
  PlacedItem,
  UnscheduledItem,
  UnscheduledReason,
  ContextTag,
  LifePillar,
} from "./types";
import { BAND_FIT, BAND_LABELS, EFFORT_LABELS, energyBand, guessEffort, maxEffort, type Effort } from "./effort";

export const WORK_START_HOUR = 6;
export const WORK_END_HOUR = 22;
export const GRID_START_HOUR = 0;
export const GRID_END_HOUR = 24;
export const SLOT_MINUTES = 15;
export const SHORT_TASK_MAX = 15;
export const BATCH_TARGET = 30;
export const ERRAND_TRAVEL_BUFFER_MIN = 20;

export function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day; // Monday as week start
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function addMinutes(date: Date, minutes: number): Date {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() + minutes);
  return d;
}

/**
 * The planner's home time zone (MIA). Scheduling hours are anchored here, so
 * the same schedule is produced on every device — a phone that's switched to
 * another time zone on a trip won't reshuffle the plan (or Google Calendar).
 */
export const HOME_TIME_ZONE = "America/New_York";

const homeParts = new Intl.DateTimeFormat("en-US", {
  timeZone: HOME_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Wall-clock parts of an instant in the home time zone. */
export function homeWallParts(date: Date): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p = Object.fromEntries(homeParts.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}

function homeOffsetMs(date: Date): number {
  const w = homeWallParts(date);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(date.getTime() / 1000) * 1000;
}

// ---- UTA (Reserve drill) days ----
// An all-day event titled exactly "UTA" marks a drill day. Items that need you
// at home or around town can't be scheduled on those days.
export const UTA_BLOCKED_PILLARS: LifePillar[] = ["family"];
export const UTA_BLOCKED_CONTEXTS: ContextTag[] = ["desk", "home", "errand"];

export function isUtaBlocked(pillar: LifePillar | null | undefined, context: ContextTag | null | undefined): boolean {
  return (!!pillar && UTA_BLOCKED_PILLARS.includes(pillar)) || (!!context && UTA_BLOCKED_CONTEXTS.includes(context));
}

/** Short label for why an item is kept off UTA days, e.g. "Family" or "Home". */
export function utaBlockLabel(pillar: LifePillar | null | undefined, context: ContextTag | null | undefined): string {
  if (pillar && UTA_BLOCKED_PILLARS.includes(pillar)) return "Family";
  if (context && UTA_BLOCKED_CONTEXTS.includes(context)) return context.charAt(0).toUpperCase() + context.slice(1);
  return "This";
}

/**
 * The UTA days as [start, end) instants in the home time zone. All-day events
 * from Google are stored at UTC midnight of their date, so the calendar date is
 * read in UTC and then turned into home-time midnights (otherwise a Saturday
 * UTA would cover Fri 8 PM – Sat 8 PM Eastern).
 */
export function utaRanges(fixed: FixedEvent[]): [Date, Date][] {
  const out: [Date, Date][] = [];
  for (const ev of fixed) {
    if (!ev.is_all_day || ev.name.trim().toUpperCase() !== "UTA") continue;
    const s = new Date(ev.start_time);
    const e = new Date(ev.end_time);
    const dateOf = (d: Date) =>
      d.getUTCHours() === 0 && d.getUTCMinutes() === 0
        ? { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate() }
        : (() => { const w = homeWallParts(d); return { y: w.y, mo: w.mo - 1, d: w.d }; })();
    const a = dateOf(s);
    const b = dateOf(e);
    const start = homeDate(a.y, a.mo, a.d, 0, 0);
    let end = homeDate(b.y, b.mo, b.d, 0, 0);
    if (end <= start) end = homeDate(a.y, a.mo, a.d + 1, 0, 0);
    out.push([start, end]);
  }
  return out;
}

export function isUtaTime(instant: Date, ranges: [Date, Date][]): boolean {
  return ranges.some(([a, b]) => instant >= a && instant < b);
}

/** The instant at a given wall-clock time in the home time zone (month is 0-based). */
export function homeDate(y: number, month: number, day: number, h: number, mi: number): Date {
  const guess = Date.UTC(y, month, day, h, mi);
  let t = guess - homeOffsetMs(new Date(guess));
  t = guess - homeOffsetMs(new Date(t)); // settle across a DST change
  return new Date(t);
}

export function slotsInWeek(weekStart: Date): Date[] {
  const slots: Date[] = [];
  for (let day = 0; day < 7; day++) {
    const date = addDays(weekStart, day);
    let cur = homeDate(date.getFullYear(), date.getMonth(), date.getDate(), WORK_START_HOUR, 0);
    const end = homeDate(date.getFullYear(), date.getMonth(), date.getDate(), WORK_END_HOUR, 0);
    while (cur < end) {
      slots.push(new Date(cur));
      cur = addMinutes(cur, SLOT_MINUTES);
    }
  }
  return slots;
}

function slotKey(d: Date): string {
  return d.toISOString();
}

/** Enroute drive blocks as busy time for the engine (they're drawn separately). */
export function enrouteAsBusy(blocks: { id: string; name: string; start_time: string; end_time: string }[]): FixedEvent[] {
  return blocks.map((b) => ({ id: `enroute-${b.id}`, name: b.name, start_time: b.start_time, end_time: b.end_time, blocks_schedule: true, engine_only: true }));
}

export function buildBusy(
  fixed: FixedEvent[],
  allSlots: Date[]
): Set<string> {
  const busy = new Set<string>();
  for (const ev of fixed) {
    if (ev.blocks_schedule === false) continue;
    if (ev.is_all_day) continue;
    const start = new Date(ev.start_time);
    const end = new Date(ev.end_time);
    for (const s of allSlots) {
      if (start <= s && s < end) {
        busy.add(slotKey(s));
      }
    }
  }
  return busy;
}

function isErrandTransition(a: ContextTag, b: ContextTag): boolean {
  return (a === "errand" && b !== "errand") || (a !== "errand" && b === "errand");
}

interface PlacedContext {
  start: Date;
  end: Date;
  context: ContextTag;
}

/**
 * A free run of slots for the item. Without a scorer it's the earliest one
 * that fits; with a scorer it's the best-scoring one (ties go to the earlier).
 */
function findSlot(
  busy: Set<string>,
  allSlots: Date[],
  durationMin: number,
  searchStart: Date,
  searchEnd: Date,
  placedContexts: PlacedContext[],
  itemContext: ContextTag,
  scorer?: (start: Date, end: Date) => number
): Date[] | null {
  let best: Date[] | null = null;
  let bestScore = -Infinity;
  const needed = Math.max(1, Math.ceil(durationMin / SLOT_MINUTES));
  const reservedSpanMs = needed * SLOT_MINUTES * 60 * 1000;
  const bufferMs = ERRAND_TRAVEL_BUFFER_MIN * 60 * 1000;

  for (let i = 0; i < allSlots.length; i++) {
    const s = allSlots[i];
    if (s < searchStart) continue;
    if (s >= searchEnd) break;
    if (busy.has(slotKey(s))) continue;

    const window = allSlots.slice(i, i + needed);
    if (window.length < needed) continue;
    if (window.some((w) => busy.has(slotKey(w)))) continue;

    const span = window[window.length - 1].getTime() + SLOT_MINUTES * 60 * 1000 - window[0].getTime();
    if (span !== reservedSpanMs) continue;

    if (addMinutes(window[0], durationMin) > searchEnd) continue;

    const itemStart = window[0];
    const itemEnd = addMinutes(window[0], durationMin);

    let blocked = false;
    for (const pc of placedContexts) {
      if (pc.end <= itemStart) {
        const gap = itemStart.getTime() - pc.end.getTime();
        if (isErrandTransition(pc.context, itemContext) && gap < bufferMs) {
          blocked = true;
          break;
        }
      } else if (pc.start >= itemEnd) {
        const gap = pc.start.getTime() - itemEnd.getTime();
        if (isErrandTransition(pc.context, itemContext) && gap < bufferMs) {
          blocked = true;
          break;
        }
      }
    }
    if (blocked) continue;

    if (!scorer) return window;
    const score = scorer(itemStart, itemEnd);
    if (score > bestScore) {
      bestScore = score;
      best = window;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Energy-aware placement
//
// Hard rules (calendars, UTA, quiet hours, errand gaps, the item's own window)
// decide where an item CAN go. Among those slots, the scheduler picks the one
// that scores best: effort vs. time-of-day energy, how soon, how full the day
// already is, a short gap after meetings, and trip rules. A slot a trip rule
// rules out is only used when nothing else fits, and the reason says so.

/** Hours after landing at home during which no focus work is scheduled. */
export const RECOVERY_HOURS = 8;
/** A departure from home before this time (minutes after midnight) is an early report. */
export const EARLY_REPORT_BEFORE_MIN = 9 * 60;
/** The evening before an early report goes light from this time on. */
export const EARLY_NIGHT_FROM_MIN = 19 * 60;
const TRIP_RULE_PENALTY = 500;
/** Minutes before a departure you're reporting / at the gate. */
export const REPORT_BUFFER_MIN = 45;
/** Ground time away from home shorter than this is a connection (on duty), not a layover. */
export const CONNECTION_MAX_HOURS = 3;
const AWAY_BLOCKED_CONTEXTS: ContextTag[] = ["home", "errand"];
const FLIGHT_TITLE = /([A-Z]{3})\u200b?\u2192\u200b?([A-Z]{3})\s*\u2022/;
const HOME_BASE = "MIA";
const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;

interface PlanContext {
  /** Booked minutes per home date ("y-m-d"). */
  load: Map<string, number>;
  meetingEnds: number[];
  recovery: [number, number][];
  earlyNights: Set<string>;
  reserveDays: Set<string>;
}

function homeDayKey(d: Date): string {
  const w = homeWallParts(d);
  return `${w.y}-${w.mo}-${w.d}`;
}

/** Calendar dates covered by an all-day event (stored at UTC midnight), as home-date keys. */
function allDayKeys(ev: FixedEvent): string[] {
  const keys: string[] = [];
  const s = new Date(ev.start_time);
  const e = new Date(ev.end_time);
  for (let t = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()); t < e.getTime(); t += DAY_MS) {
    const d = new Date(t);
    keys.push(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`);
    if (keys.length > 60) break;
  }
  if (!keys.length) keys.push(`${s.getUTCFullYear()}-${s.getUTCMonth() + 1}-${s.getUTCDate()}`);
  return keys;
}

function buildPlanContext(fixed: FixedEvent[]): PlanContext {
  const ctx: PlanContext = { load: new Map(), meetingEnds: [], recovery: [], earlyNights: new Set(), reserveDays: new Set() };
  for (const ev of fixed) {
    if (ev.is_all_day) {
      if (/\breserve\b/i.test(ev.name)) for (const k of allDayKeys(ev)) ctx.reserveDays.add(k);
      continue;
    }
    const s = new Date(ev.start_time);
    const e = new Date(ev.end_time);
    if (ev.blocks_schedule !== false) {
      const k = homeDayKey(s);
      ctx.load.set(k, (ctx.load.get(k) ?? 0) + Math.max(0, (e.getTime() - s.getTime()) / 60000));
      ctx.meetingEnds.push(e.getTime());
    }
    const leg = FLIGHT_TITLE.exec(ev.name);
    if (leg) {
      if (leg[2] === HOME_BASE) ctx.recovery.push([e.getTime(), e.getTime() + RECOVERY_HOURS * HOUR_MS]);
      if (leg[1] === HOME_BASE) {
        const w = homeWallParts(s);
        if (w.h * 60 + w.mi < EARLY_REPORT_BEFORE_MIN) ctx.earlyNights.add(homeDayKey(new Date(s.getTime() - 12 * HOUR_MS)));
      }
    }
  }
  return ctx;
}

interface SlotScore {
  score: number;
  reason: string;
}

function scoreSlot(ctx: PlanContext, effort: Effort, tier: number, earliest: Date, start: Date, end: Date): SlotScore {
  const ws = homeWallParts(start);
  const we = homeWallParts(new Date(end.getTime() - 60000));
  const startMin = ws.h * 60 + ws.mi;
  const bandStart = energyBand(startMin);
  const bandEnd = energyBand(we.h * 60 + we.mi);
  let score = Math.min(BAND_FIT[effort][bandStart], BAND_FIT[effort][bandEnd]);

  // Sooner is better, more so for top-tier items.
  const wait = Math.max(0, start.getTime() - earliest.getTime());
  score -= (wait / DAY_MS) * (tier <= 1 ? 6 : 3) + (wait / HOUR_MS) * 0.05;

  // Spread the week: every hour already booked that day costs a little.
  const dayKey = homeDayKey(start);
  const bookedH = (ctx.load.get(dayKey) ?? 0) / 60;
  score -= bookedH * 2.5;

  // A short breather after meetings and flights.
  if (ctx.meetingEnds.some((t) => start.getTime() >= t && start.getTime() - t < 10 * 60000)) score -= 5;

  const notes: string[] = [];
  const inRecovery = ctx.recovery.some(([a, b]) => start.getTime() < b && end.getTime() > a);
  const earlyNight = ctx.earlyNights.has(dayKey) && startMin + (end.getTime() - start.getTime()) / 60000 > EARLY_NIGHT_FROM_MIN;
  const reserveMorning = ctx.reserveDays.has(dayKey) && bandStart === "morning";
  if (effort === "focus") {
    if (inRecovery) { score -= TRIP_RULE_PENALTY; notes.push("inside post-trip recovery"); }
    if (earlyNight) { score -= TRIP_RULE_PENALTY; notes.push("the evening before an early report"); }
    if (reserveMorning) { score -= TRIP_RULE_PENALTY; notes.push("a reserve-day morning"); }
  } else if (effort === "routine") {
    if (inRecovery) score -= 15;
    if (earlyNight) score -= 30;
  }

  const load = bookedH > 0 ? ` · ${Math.round(bookedH * 10) / 10} h already booked that day` : " · open day";
  const reason = notes.length
    ? `Only slot that fit: ${notes.join(", ")}`
    : `${EFFORT_LABELS[effort]} task in your ${BAND_LABELS[bandStart]}${load}`;
  return { score, reason };
}

interface BatchedTask {
  name: string;
  tier: number;
  durationMin: number;
  searchStart: Date;
  searchEnd: Date;
  context: ContextTag;
  room: number;
  isBatch: boolean;
  memberNames?: string[];
  memberIds?: string[];
  memberId?: string;
  pillar: LifePillar | null;
  effort: Effort;
  effortAuto: boolean;
}

function taskEffort(t: Task): { effort: Effort; auto: boolean } {
  if (t.effort) return { effort: t.effort, auto: t.effort_auto !== false };
  return { effort: guessEffort({ name: t.name, context: t.context, durationMin: t.duration_min, pillar: t.pillar }).effort, auto: true };
}

function batchShortTasks(taskList: Task[]): BatchedTask[] {
  const short = taskList.filter((t) => t.duration_min <= SHORT_TASK_MAX);
  const normal: BatchedTask[] = taskList
    .filter((t) => t.duration_min > SHORT_TASK_MAX)
    .map((t) => ({
      name: t.name,
      tier: t.tier,
      durationMin: t.duration_min,
      searchStart: new Date(t.search_start),
      searchEnd: new Date(t.deadline),
      context: t.context,
      pillar: t.pillar ?? null,
      room: 0,
      isBatch: false,
      memberId: t.id,
      effort: taskEffort(t).effort,
      effortAuto: taskEffort(t).auto,
    }));

  const byContext = new Map<ContextTag, Task[]>();
  for (const t of short) {
    if (!byContext.has(t.context)) byContext.set(t.context, []);
    byContext.get(t.context)!.push(t);
  }

  const batched: BatchedTask[] = [];
  for (const [, items] of byContext) {
    items.sort((a, b) => a.tier - b.tier || new Date(a.deadline).getTime() - new Date(b.deadline).getTime());
    let i = 0;
    while (i < items.length) {
      const group: Task[] = [items[i]];
      let total = items[i].duration_min;
      let j = i + 1;
      while (j < items.length && total + items[j].duration_min <= BATCH_TARGET) {
        group.push(items[j]);
        total += items[j].duration_min;
        j++;
      }

      batched.push({
        name: group.map((g) => g.name).join(" + "),
        tier: Math.min(...group.map((g) => g.tier)),
        searchStart: new Date(Math.max(...group.map((g) => new Date(g.search_start).getTime()))),
        searchEnd: new Date(Math.min(...group.map((g) => new Date(g.deadline).getTime()))),
        durationMin: total,
        context: group[0].context,
        pillar: group[0].pillar ?? null,
        room: BATCH_TARGET - total,
        isBatch: group.length > 1,
        memberNames: group.length > 1 ? group.map((g) => g.name) : undefined,
        memberIds: group.map((g) => g.id),
        effort: maxEffort(group.map((g) => taskEffort(g).effort)),
        effortAuto: group.length > 1 || taskEffort(group[0]).auto,
      });
      i = j;
    }
  }

  return [...normal, ...batched];
}

interface Placeable {
  id: string;
  name: string;
  tier: number;
  durationMin: number;
  searchStart: Date;
  searchEnd: Date;
  context: ContextTag;
  room: number;
  kind: "Habit" | "Task";
  isBatch: boolean;
  memberNames?: string[];
  memberIds?: string[];
  pillar: LifePillar | null;
  effort: Effort;
  effortAuto: boolean;
}

export function runEngine(
  weekStart: Date,
  fixedEvents: FixedEvent[],
  habits: Habit[],
  tasks: Task[]
): { placed: PlacedItem[]; unscheduled: UnscheduledItem[] } {
  const allSlots = slotsInWeek(weekStart);
  const busy = buildBusy(fixedEvents, allSlots);
  // Report time: nothing in the 45 minutes before a flight leg departs.
  const legs = fixedEvents
    .filter((ev) => !ev.is_all_day)
    .map((ev) => ({ ev, m: FLIGHT_TITLE.exec(ev.name) }))
    .filter((x): x is { ev: FixedEvent; m: RegExpExecArray } => !!x.m)
    .map(({ ev, m }) => ({ origin: m[1], dest: m[2], dep: new Date(ev.start_time).getTime(), arr: new Date(ev.end_time).getTime() }))
    .sort((a, b) => a.dep - b.dep);
  const markBusy = (set: Set<string>, from: number, to: number) => {
    for (const sl of allSlots) if (sl.getTime() >= from && sl.getTime() < to) set.add(slotKey(sl));
  };
  for (const leg of legs) markBusy(busy, leg.dep - REPORT_BUFFER_MIN * 60000, leg.dep);
  // Between legs away from home: a short connection is duty time (blocked for
  // everything); a longer layover keeps home, errand and family items off.
  const awayBusy = new Set<string>();
  for (let i = 0; i < legs.length - 1; i++) {
    const a = legs[i];
    const b = legs[i + 1];
    if (a.dest === HOME_BASE || b.origin !== a.dest || b.dep <= a.arr) continue;
    if (b.dep - a.arr < CONNECTION_MAX_HOURS * HOUR_MS) markBusy(busy, a.arr, b.dep);
    else markBusy(awayBusy, a.arr, b.dep);
  }

  const utaBusy = new Set<string>();
  const uta = utaRanges(fixedEvents);
  for (const s of allSlots) {
    if (isUtaTime(s, uta)) utaBusy.add(slotKey(s));
  }

  const placeables: Placeable[] = [];

  for (const h of habits) {
    placeables.push({
      id: h.id,
      name: h.name,
      tier: h.tier,
      durationMin: h.duration_min,
      searchStart: new Date(h.search_start),
      searchEnd: new Date(h.search_end),
      context: h.context,
      pillar: h.pillar ?? null,
      room: 0,
      kind: "Habit",
      isBatch: false,
      effort: h.effort ?? guessEffort({ name: h.name, context: h.context, durationMin: h.duration_min, pillar: h.pillar }).effort,
      effortAuto: !h.effort || h.effort_auto !== false,
    });
  }

  for (const b of batchShortTasks(tasks)) {
    const stableId = b.isBatch && b.memberIds && b.memberIds.length > 0
      ? `batch-${b.memberIds.join("--")}`
      : b.memberId ?? crypto.randomUUID();
    placeables.push({
      id: stableId,
      name: b.name,
      tier: b.tier,
      durationMin: b.durationMin,
      searchStart: b.searchStart,
      searchEnd: b.searchEnd,
      context: b.context,
      pillar: b.pillar,
      room: b.room,
      kind: "Task",
      isBatch: b.isBatch,
      memberNames: b.memberNames,
      memberIds: b.memberIds,
      effort: b.effort,
      effortAuto: b.effortAuto,
    });
  }

  placeables.sort((a, b) => a.tier - b.tier || a.searchEnd.getTime() - b.searchEnd.getTime());

  const placed: PlacedItem[] = [];
  const unscheduled: UnscheduledItem[] = [];
  const placedContexts: PlacedContext[] = [];
  const plan = buildPlanContext(fixedEvents);

  for (const p of placeables) {
    const isHomeOnly = isUtaBlocked(p.pillar, p.context);
    const needsHome = p.pillar === "family" || AWAY_BLOCKED_CONTEXTS.includes(p.context);
    const effectiveBusy =
      isHomeOnly || needsHome
        ? new Set([...busy, ...(isHomeOnly ? utaBusy : []), ...(needsHome ? awayBusy : [])])
        : busy;
    const earliest = new Date(Math.max(p.searchStart.getTime(), allSlots[0]?.getTime() ?? 0));
    const scorer = (a: Date, b: Date) => scoreSlot(plan, p.effort, p.tier, earliest, a, b).score;
    const window = findSlot(effectiveBusy, allSlots, p.durationMin, p.searchStart, p.searchEnd, placedContexts, p.context, scorer);
    if (window) {
      for (const w of window) busy.add(slotKey(w));
      const itemStart = window[0];
      const itemEnd = addMinutes(window[0], p.durationMin);
      const why = scoreSlot(plan, p.effort, p.tier, earliest, itemStart, itemEnd).reason;
      const dayKey = homeDayKey(itemStart);
      plan.load.set(dayKey, (plan.load.get(dayKey) ?? 0) + p.durationMin);
      placedContexts.push({ start: itemStart, end: itemEnd, context: p.context });
      placed.push({
        id: p.id,
        name: p.name,
        kind: p.kind,
        tier: p.tier,
        context: p.context,
        pillar: p.pillar,
        start: window[0],
        end: addMinutes(window[0], p.durationMin),
        room: p.room,
        isBatch: p.isBatch,
        memberNames: p.memberNames,
        memberIds: p.memberIds,
        effort: p.effort,
        effortAuto: p.effortAuto,
        placementReason: why,
      });
    } else {
      // A window that starts after this week belongs to a later week's plan.
      if (p.searchStart >= addDays(weekStart, 7)) continue;
      let reason: UnscheduledReason;
      if (p.searchEnd <= weekStart) {
        reason = "window_ended";
      } else if (p.searchEnd.getTime() - p.searchStart.getTime() < p.durationMin * 60 * 1000) {
        reason = "window_too_short";
      } else if (!findSlot(new Set(), allSlots, p.durationMin, p.searchStart, p.searchEnd, [], p.context)) {
        reason = "outside_hours";
      } else if (isHomeOnly && findSlot(busy, allSlots, p.durationMin, p.searchStart, p.searchEnd, placedContexts, p.context)) {
        reason = "family_uta";
      } else {
        reason = "no_free_time";
      }
      unscheduled.push({
        id: p.id,
        name: p.name,
        kind: p.kind,
        tier: p.tier,
        deadline: p.searchEnd,
        windowStart: p.searchStart,
        durationMin: p.durationMin,
        reason,
        isBatch: p.isBatch,
      });
    }
  }

  for (const ev of fixedEvents) {
    if (ev.engine_only) continue;
    const evStart = new Date(ev.start_time);
    const evEnd = new Date(ev.end_time);
    const weekEndDate = addDays(weekStart, 7);
    if (evStart >= weekStart && evStart < weekEndDate) {
      placed.push({
        id: ev.id,
        name: ev.name,
        kind: "Fixed Event",
        tier: 0,
        context: "other",
        pillar: ev.pillar ?? null,
        start: evStart,
        end: evEnd,
        room: 0,
        isBatch: false,
        sourceCalendarId: ev.source_calendar_id,
        blocksSchedule: ev.blocks_schedule !== false,
        readOnly: ev.google_can_edit === false,
        isAllDay: ev.is_all_day ?? false,
      });
    }
  }

  placed.sort((a, b) => a.start.getTime() - b.start.getTime());

  return { placed, unscheduled };
}
