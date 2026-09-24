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

function findSlot(
  busy: Set<string>,
  allSlots: Date[],
  durationMin: number,
  searchStart: Date,
  searchEnd: Date,
  placedContexts: PlacedContext[],
  itemContext: ContextTag
): Date[] | null {
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

    return window;
  }
  return null;
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
}

export function runEngine(
  weekStart: Date,
  fixedEvents: FixedEvent[],
  habits: Habit[],
  tasks: Task[]
): { placed: PlacedItem[]; unscheduled: UnscheduledItem[] } {
  const allSlots = slotsInWeek(weekStart);
  const busy = buildBusy(fixedEvents, allSlots);

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
    });
  }

  placeables.sort((a, b) => a.tier - b.tier || a.searchEnd.getTime() - b.searchEnd.getTime());

  const placed: PlacedItem[] = [];
  const unscheduled: UnscheduledItem[] = [];
  const placedContexts: PlacedContext[] = [];

  for (const p of placeables) {
    const isHomeOnly = isUtaBlocked(p.pillar, p.context);
    const effectiveBusy = isHomeOnly ? new Set([...busy, ...utaBusy]) : busy;
    const window = findSlot(effectiveBusy, allSlots, p.durationMin, p.searchStart, p.searchEnd, placedContexts, p.context);
    if (window) {
      for (const w of window) busy.add(slotKey(w));
      const itemStart = window[0];
      const itemEnd = addMinutes(window[0], p.durationMin);
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
