import { useEffect, useMemo, useState, useRef } from "react";
import {
  CalendarDays,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Plus,
  Clock,
  Layers,
  AlertTriangle,
  Trash2,
  X,
  GripVertical,
  Settings,
  RefreshCw,
  MoreVertical,
  Monitor,
  Smartphone,
  Plane,
  Pencil,
  Repeat,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { recheckEnrouteBlocks, type StoredEnrouteBlock } from "@/lib/calendarHygiene";
import {
  runEngine,
  getWeekStart,
  addDays,
  GRID_START_HOUR,
  GRID_END_HOUR,
} from "@/lib/schedulingEngine";
import type {
  FixedEvent,
  Habit,
  Task,
  PlacedItem,
  UnscheduledItem,
  ContextTag,
  CalendarConnection,
  LifePillar,
  ItemKind,
  TaskOccurrence,
  FixedEventOccurrence,
  HabitOccurrence,
  RecurrenceScope,
} from "@/lib/types";
import { CONTEXT_COLORS, TIER_LABELS, PILLARS, PILLAR_LABELS, PILLAR_COLORS, getPillarColor } from "@/lib/types";
import { AddItemModal, type EditTarget } from "@/components/AddItemModal";
import { CalendarConnectionsPanel } from "@/components/CalendarConnectionsPanel";
import { getSyncStatus, pullFromGoogle, mirrorToGoogle, deleteFromGoogle, scheduleAutoPush } from "@/lib/gcalSync";
import { parseRecurrenceFromItem, expandRecurrence, formatLocalDate, formatRecurrenceSummary } from "@/lib/recurrence";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface EventMapEntry {
  id: string;
  google_event_id: string;
  item_type: string;
  item_id: string | null;
  item_name: string;
  calendar_role: string;
  calendar_id: string;
  start_time: string;
  end_time: string;
}

const SLOT_MIN = 15;
const SLOT_PX = 16;
const NIGHT_START_HOUR = 21;
const NIGHT_END_HOUR = 9;
const HOME_ONLY_PILLARS: LifePillar[] = ["family"];

function snapToSlot(d: Date): Date {
  const m = d.getMinutes();
  const snapped = Math.floor(m / SLOT_MIN) * SLOT_MIN;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), snapped, 0, 0);
}

function isQuietTime(start: Date, end: Date): boolean {
  for (let h = start.getHours(); h < end.getHours() || (h === end.getHours() && end.getMinutes() > 0); h = (h + 1) % 24) {
    if (h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR) return true;
  }
  return false;
}

function isUTADay(date: Date, fixedEvents: FixedEvent[]): boolean {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  for (const ev of fixedEvents) {
    if (ev.is_all_day && ev.name.trim().toUpperCase() === "UTA") {
      const evStart = new Date(ev.start_time);
      const evEnd = new Date(ev.end_time);
      if (dayStart < evEnd && dayEnd > evStart) return true;
    }
  }
  return false;
}

function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function findNextFreeSlot(
  itemToMove: PlacedItem,
  newStart: Date,
  durationMin: number,
  allItems: PlacedItem[],
  fixedEvents: FixedEvent[],
): Date | null {
  const durationMs = durationMin * 60 * 1000;
  const origDay = new Date(newStart.getFullYear(), newStart.getMonth(), newStart.getDate());
  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const day = new Date(origDay.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  const earliest = dayOffset === 0 ? newStart : new Date(day.getFullYear(), day.getMonth(), day.getDate(), NIGHT_END_HOUR, 0, 0, 0);
    for (let h = earliest.getHours(); h < 24; h++) {
      for (let m = h === earliest.getHours() ? earliest.getMinutes() : 0; m < 60; m += SLOT_MIN) {
        const slotStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
        const slotEnd = new Date(slotStart.getTime() + durationMs);
        if (slotEnd.getHours() >= 24 || (slotEnd.getDate() !== slotStart.getDate() && slotEnd.getHours() > 0)) continue;
        if (isQuietTime(slotStart, slotEnd)) continue;
        if (itemToMove.pillar && HOME_ONLY_PILLARS.includes(itemToMove.pillar) && isUTADay(slotStart, fixedEvents)) continue;
        let conflict = false;
        for (const other of allItems) {
          if (other.id === itemToMove.id) continue;
          if (other.kind === "Enroute") continue;
          if (rangesOverlap(slotStart, slotEnd, other.start, other.end)) {
            conflict = true;
            break;
          }
        }
        if (!conflict) return slotStart;
      }
    }
  }
  return null;
}

const HOURS = Array.from(
  { length: GRID_END_HOUR - GRID_START_HOUR },
  (_, i) => GRID_START_HOUR + i
);

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTimeRange(start: Date, end: Date): string {
  const startStr = formatTime(start);
  const endStr = formatTime(end);
  const startPeriod = startStr.slice(-2);
  const endPeriod = endStr.slice(-2);
  if (startPeriod === endPeriod) {
    return `${startStr.slice(0, -3)}\u2013${endStr}`;
  }
  return `${startStr}\u2013${endStr}`;
}

function formatDay(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getSyncFreshness(date: Date | null): { label: string; colorClass: string } {
  if (!date) return { label: "Never synced", colorClass: "text-red-400" };
  const diffMs = Date.now() - date.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffHours / 24;
  let label: string;
  if (diffHours < 1) {
    const mins = Math.max(1, Math.round(diffMs / 60000));
    label = mins + "m ago";
  } else if (diffHours < 24) {
    label = Math.round(diffHours) + "h ago";
  } else {
    label = Math.round(diffDays) + "d ago";
  }
  let colorClass = "text-emerald-400";
  if (diffDays >= 7) colorClass = "text-red-400";
  else if (diffDays >= 3) colorClass = "text-amber-400";
  return { label, colorClass };
}

type CalendarViewMode = "mobile" | "desktop";

const CALENDAR_VIEW_MODE_KEY = "smartScheduler.calendarViewMode";

// Some mobile browsers (Chrome/Safari's "Request Desktop Website" toggle, enabled
// per-site and easy to trigger by accident) ignore the page's own viewport meta tag
// and report a much wider window.innerWidth than the phone's real screen. That alone
// defeats a plain "(max-width: 639px)" check. window.screen's width/height, on the
// other hand, reflects the physical hardware regardless of that override, so we use
// the device's *short side* as a second signal. iPhone 15 Pro's screen is 393 CSS px
// wide (852 tall); iPhone 15 Pro Max is 430 wide. 480 comfortably covers current
// phones (incl. Pro Max) while staying well under tablet (768pt+) short sides.
const PHONE_SHORT_SIDE_CEILING = 480;

function detectAutoCalendarViewMode(): CalendarViewMode {
  if (typeof window === "undefined") return "desktop";
  if (window.matchMedia("(max-width: 639px)").matches) return "mobile";
  const isTouchDevice =
    window.matchMedia("(pointer: coarse)").matches || (navigator.maxTouchPoints ?? 0) > 0;
  const shortSide = Math.min(window.screen?.width || Infinity, window.screen?.height || Infinity);
  return isTouchDevice && shortSide <= PHONE_SHORT_SIDE_CEILING ? "mobile" : "desktop";
}

function useCalendarViewMode() {
  const [override, setOverride] = useState<CalendarViewMode | null>(() => {
    if (typeof window === "undefined") return null;
    const saved = window.localStorage.getItem(CALENDAR_VIEW_MODE_KEY);
    return saved === "mobile" || saved === "desktop" ? saved : null;
  });
  const [autoMode, setAutoMode] = useState<CalendarViewMode>(detectAutoCalendarViewMode);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const recheck = () => setAutoMode(detectAutoCalendarViewMode());
    const mq = window.matchMedia("(max-width: 639px)");
    mq.addEventListener("change", recheck);
    window.addEventListener("orientationchange", recheck);
    window.addEventListener("resize", recheck);
    return () => {
      mq.removeEventListener("change", recheck);
      window.removeEventListener("orientationchange", recheck);
      window.removeEventListener("resize", recheck);
    };
  }, []);

  const layout: CalendarViewMode = override ?? autoMode;

  const toggle = () => {
    const next: CalendarViewMode = layout === "mobile" ? "desktop" : "mobile";
    setOverride(next);
    try {
      window.localStorage.setItem(CALENDAR_VIEW_MODE_KEY, next);
    } catch {
      // ignore storage errors (private browsing, etc.)
    }
  };

  return { layout, isOverridden: override !== null, toggle };
}

export function CalendarView({
  weekStart,
  setWeekStart,
}: {
  weekStart: Date;
  setWeekStart: (d: Date) => void;
}) {
  const { layout, isOverridden, toggle: toggleViewMode } = useCalendarViewMode();
  const [fixedEvents, setFixedEvents] = useState<FixedEvent[]>([]);
  const [enrouteBlocks, setEnrouteBlocks] = useState<StoredEnrouteBlock[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [occurrences, setOccurrences] = useState<TaskOccurrence[]>([]);
  const [fixedEventOccurrences, setFixedEventOccurrences] = useState<FixedEventOccurrence[]>([]);
  const [habitOccurrences, setHabitOccurrences] = useState<HabitOccurrence[]>([]);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [scopeDialog, setScopeDialog] = useState<{ action: "delete" | "edit"; item: PlacedItem } | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addPrefillDate, setAddPrefillDate] = useState<Date | null>(null);
  const [selectedItem, setSelectedItem] = useState<PlacedItem | null>(null);
  const [showConnections, setShowConnections] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
      const [recheckingEnroute, setRecheckingEnroute] = useState(false);
      const [recheckMessage, setRecheckMessage] = useState<string | null>(null);

      async function recheckFlights() {
        setRecheckingEnroute(true);
        setRecheckMessage(null);
        try {
          const result = await recheckEnrouteBlocks();
          setRecheckMessage(
            `Recheck flights: ${result.created} added, ${result.updated} updated, ${result.deleted} removed.`
          );
        } catch (err) {
          setRecheckMessage("Could not recheck flights.");
        } finally {
          setRecheckingEnroute(false);
        }
      }
  const [eventMap, setEventMap] = useState<EventMapEntry[]>([]);
  const [showOverflow, setShowOverflow] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [mobileDayIndex, setMobileDayIndex] = useState(() => {
    const diff = Math.floor((new Date().setHours(0, 0, 0, 0) - weekStart.getTime()) / (24 * 60 * 60 * 1000));
    return diff >= 0 && diff < 7 ? diff : 0;
  });
  const [viewMode, setViewMode] = useState<"week" | "month">("week");
  const [showMiniMonth, setShowMiniMonth] = useState(false);
  const [resizeState, setResizeState] = useState<{ item: PlacedItem; startY: number; originalEnd: Date; previewEnd: Date } | null>(null);

  // Compute the display range used for data fetching and recurring expansion.
  // In week mode this is weekStart..weekStart+7. In month mode it spans the
  // 6-row grid (42 days) starting from the Monday of the week containing the 1st.
  const monthGridStart = useMemo(() => {
    const firstOfMonth = new Date(weekStart.getFullYear(), weekStart.getMonth(), 1);
    return getWeekStart(firstOfMonth);
  }, [weekStart]);
  const monthGridEnd = useMemo(() => addDays(monthGridStart, 42), [monthGridStart]);
  const displayStart = viewMode === "month" ? monthGridStart : weekStart;
  const displayEnd = viewMode === "month" ? monthGridEnd : addDays(weekStart, 7);

  async function loadData(): Promise<{ fixedEvents: FixedEvent[]; habits: Habit[]; tasks: Task[]; eventMap: EventMapEntry[]; enrouteBlocks: StoredEnrouteBlock[] }> {
    setLoading(true);
    const rangeStart = viewMode === "month" ? monthGridStart : weekStart;
    const rangeEnd = viewMode === "month" ? monthGridEnd : addDays(weekStart, 7);

    const [evRes, recEvRes, habRes, taskRes, mapRes, ebRes, occRes, feoccRes, hoccRes] = await Promise.all([
      supabase
        .from("fixed_events")
        .select("*")
        .gte("end_time", rangeStart.toISOString())
        .lt("start_time", rangeEnd.toISOString())
        .order("start_time"),
      // A recurring event's row only stores its FIRST instance, so the range
      // filter above drops it once you navigate past that first week. Fetch
      // every recurring parent that starts before the range ends; the
      // recurrence expansion below decides which occurrences are visible.
      supabase
        .from("fixed_events")
        .select("*")
        .eq("recurrence_enabled", true)
        .lt("start_time", rangeEnd.toISOString()),
      supabase.from("habits").select("*").order("tier"),
      supabase.from("tasks").select("*").order("tier"),
      supabase.from("gcal_event_map").select("*"),
      supabase.from("enroute_blocks").select("*").gte("end_time", rangeStart.toISOString()).lt("start_time", rangeEnd.toISOString()).order("start_time"),
      supabase.from("task_occurrences").select("*").gte("occurrence_date", formatLocalDate(rangeStart)).lte("occurrence_date", formatLocalDate(addDays(rangeEnd, -1))),
      supabase.from("fixed_event_occurrences").select("*").gte("occurrence_date", formatLocalDate(rangeStart)).lte("occurrence_date", formatLocalDate(addDays(rangeEnd, -1))),
      supabase.from("habit_occurrences").select("*").gte("occurrence_date", formatLocalDate(rangeStart)).lte("occurrence_date", formatLocalDate(addDays(rangeEnd, -1))),
    ]);

    const feById = new Map<string, FixedEvent>();
    for (const e of [...((evRes.data as FixedEvent[]) ?? []), ...((recEvRes.data as FixedEvent[]) ?? [])]) {
      feById.set(e.id, e);
    }
    const fe = [...feById.values()].sort(
      (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime()
    );
    const ha = (habRes.data as Habit[]) ?? [];
    const ta = (taskRes.data as Task[]) ?? [];
    const em = (mapRes.data as EventMapEntry[]) ?? [];
    const eb = (ebRes.data as StoredEnrouteBlock[]) ?? [];
    const oc = (occRes.data as TaskOccurrence[]) ?? [];
    const feo = (feoccRes.data as FixedEventOccurrence[]) ?? [];
    const ho = (hoccRes.data as HabitOccurrence[]) ?? [];

    setFixedEvents(fe);
    setHabits(ha);
    setTasks(ta);
    setEventMap(em);
    setEnrouteBlocks(eb);
    setOccurrences(oc);
    setFixedEventOccurrences(feo);
    setHabitOccurrences(ho);
    setLoading(false);

    return { fixedEvents: fe, habits: ha, tasks: ta, eventMap: em, enrouteBlocks: eb };
  }

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, viewMode]);

  useEffect(() => {
    (async () => {
      const status = await getSyncStatus();
      const conns = (status?.connections ?? []) as CalendarConnection[];
      const timestamps = conns
        .map((c) => c.last_synced_at)
        .filter((t): t is string => !!t);
      if (timestamps.length > 0) {
        const latest = timestamps.reduce((a, b) => (new Date(a) > new Date(b) ? a : b));
        setLastSyncedAt(new Date(latest));
      }
    })();
  }, []);

  const { placed, unscheduled } = useMemo(() => {
    const recurringTasks = tasks.filter((t) => t.recurrence_enabled);
    const nonRecurringTasks = tasks.filter((t) => !t.recurrence_enabled);
    const rangeStart = displayStart;
    const rangeEnd = displayEnd;
    const occByFeDate = new Map<string, FixedEventOccurrence>();
    for (const o of fixedEventOccurrences) {
      occByFeDate.set(`${o.item_id}|${o.occurrence_date}`, o);
    }
    const recurringFixedEvents = fixedEvents.filter((e) => e.recurrence_enabled);
    const fixedOccurrenceItems: PlacedItem[] = [];
    const fixedOccurrenceEvents: FixedEvent[] = [];

    // Expand recurring Fixed Events into individual occurrences
    for (const fe of recurringFixedEvents) {
      const rule = parseRecurrenceFromItem(fe);
      const startDate = new Date(fe.start_time);
      const occDates = expandRecurrence(rule, startDate, rangeStart, rangeEnd);
      for (const occDate of occDates) {
        const dateStr = formatLocalDate(occDate);
        const existing = occByFeDate.get(`${fe.id}|${dateStr}`);
        if (existing?.skipped) continue;
        const feStart = new Date(fe.start_time);
        const feEnd = new Date(fe.end_time);
        const durationMs = feEnd.getTime() - feStart.getTime();
        let itemStart: Date;
        let itemEnd: Date;
        if (existing?.override_start && existing?.override_end) {
          itemStart = new Date(existing.override_start);
          itemEnd = new Date(existing.override_end);
        } else {
          itemStart = new Date(occDate);
          itemStart.setHours(feStart.getHours(), feStart.getMinutes(), 0, 0);
          itemEnd = new Date(itemStart.getTime() + durationMs);
        }
        const occId = `${fe.id}--${dateStr}`;
        fixedOccurrenceEvents.push({
          ...fe,
          id: occId,
          start_time: itemStart.toISOString(),
          end_time: itemEnd.toISOString(),
          recurrence_enabled: false,
        });
        fixedOccurrenceItems.push({
          id: occId,
          name: fe.name,
          kind: "Fixed Event" as ItemKind,
          tier: 0,
          context: "other" as ContextTag,
          start: itemStart,
          end: itemEnd,
          pillar: fe.pillar ?? null,
          room: 0,
          isBatch: false,
          isAllDay: false,
          isRecurringOccurrence: true,
          recurringItemId: fe.id,
          recurringItemKind: "Fixed Event",
          occurrenceDate: dateStr,
          occurrenceCompleted: existing?.completed ?? false,
          recurrenceSummary: formatRecurrenceSummary(rule),
        });
      }
    }

    const fixedOccurrenceIds = new Set(fixedOccurrenceEvents.map((e) => e.id));
    const result = runEngine(
      displayStart,
      [...fixedEvents.filter((e) => !e.recurrence_enabled), ...fixedOccurrenceEvents],
      habits.filter((h) => !h.recurrence_enabled),
      nonRecurringTasks
    );
    const mapByItemId = new Map<string, EventMapEntry>();
    for (const m of eventMap) {
      if (m.item_id) mapByItemId.set(m.item_id, m);
    }
    const enriched = result.placed.filter((p) => !fixedOccurrenceIds.has(p.id)).map((p) => {
      const m = mapByItemId.get(p.id);
      if (!m) return p;
      return {
        ...p,
        googleEventId: m.google_event_id,
        googleCalendarId: m.calendar_id,
        googleCalendarRole: m.calendar_role,
      };
    });
    const enrouteItems: PlacedItem[] = enrouteBlocks.map((b) => ({
      id: b.id,
      name: `🚗 ${b.name}`,
      kind: "Enroute" as ItemKind,
      tier: 0,
      context: "other" as ContextTag,
      start: new Date(b.start_time),
      end: new Date(b.end_time),
      pillar: "civ_career" as LifePillar,
      room: 0,
      isBatch: false,
      isAllDay: false,
    }));

    // Expand recurring tasks into individual occurrences
    const occByTaskDate = new Map<string, TaskOccurrence>();
    for (const o of occurrences) {
      occByTaskDate.set(`${o.task_id}|${o.occurrence_date}`, o);
    }
    const occByHabitDate = new Map<string, HabitOccurrence>();
    for (const o of habitOccurrences) {
      occByHabitDate.set(`${o.item_id}|${o.occurrence_date}`, o);
    }
    const recurringItems: PlacedItem[] = [];
    for (const task of recurringTasks) {
      const rule = parseRecurrenceFromItem(task);
      const startDate = new Date(task.search_start);
      const occDates = expandRecurrence(rule, startDate, rangeStart, rangeEnd);
      for (const occDate of occDates) {
        const dateStr = formatLocalDate(occDate);
        const existing = occByTaskDate.get(`${task.id}|${dateStr}`);
        if (existing?.skipped) continue;
        let itemStart: Date;
        let itemEnd: Date;
        if (existing?.override_start && existing?.override_end) {
          itemStart = new Date(existing.override_start);
          itemEnd = new Date(existing.override_end);
        } else {
          itemStart = new Date(occDate);
          itemStart.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
          itemEnd = new Date(itemStart.getTime() + task.duration_min * 60 * 1000);
        }
        recurringItems.push({
          id: `${task.id}--${dateStr}`,
          name: task.name,
          kind: "Task" as ItemKind,
          tier: task.tier,
          context: task.context,
          start: itemStart,
          end: itemEnd,
          pillar: task.pillar ?? null,
          room: 0,
          isBatch: false,
          isAllDay: false,
          isRecurringOccurrence: true,
          recurringItemId: task.id,
          recurringItemKind: "Task",
          occurrenceDate: dateStr,
          occurrenceCompleted: existing?.completed ?? false,
          recurrenceSummary: formatRecurrenceSummary(rule),
        });
      }
    }

    recurringItems.push(...fixedOccurrenceItems);

    // Expand recurring Habits into individual occurrences
    const recurringHabits = habits.filter((h) => h.recurrence_enabled);
    for (const habit of recurringHabits) {
      const rule = parseRecurrenceFromItem(habit);
      const startDate = new Date(habit.search_start);
      const occDates = expandRecurrence(rule, startDate, rangeStart, rangeEnd);
      for (const occDate of occDates) {
        const dateStr = formatLocalDate(occDate);
        const existing = occByHabitDate.get(`${habit.id}|${dateStr}`);
        if (existing?.skipped) continue;
        let itemStart: Date;
        let itemEnd: Date;
        if (existing?.override_start && existing?.override_end) {
          itemStart = new Date(existing.override_start);
          itemEnd = new Date(existing.override_end);
        } else {
          itemStart = new Date(occDate);
          itemStart.setHours(startDate.getHours(), startDate.getMinutes(), 0, 0);
          itemEnd = new Date(itemStart.getTime() + habit.duration_min * 60 * 1000);
        }
        recurringItems.push({
          id: `${habit.id}--${dateStr}`,
          name: habit.name,
          kind: "Habit" as ItemKind,
          tier: habit.tier,
          context: habit.context,
          start: itemStart,
          end: itemEnd,
          pillar: habit.pillar ?? null,
          room: 0,
          isBatch: false,
          isAllDay: false,
          isRecurringOccurrence: true,
          recurringItemId: habit.id,
          recurringItemKind: "Habit",
          occurrenceDate: dateStr,
          occurrenceCompleted: existing?.completed ?? false,
          recurrenceSummary: formatRecurrenceSummary(rule),
        });
      }
    }

    // Feature 2: Auto-detect all-day Fixed Events (24h+ duration)
    const finalPlaced = [...enriched, ...enrouteItems, ...recurringItems].map((p) => {
      if (p.kind === "Fixed Event" && !p.isAllDay) {
        const durationMs = p.end.getTime() - p.start.getTime();
        if (durationMs >= 24 * 60 * 60 * 1000) {
          return { ...p, isAllDay: true };
        }
      }
      return p;
    });
    return { placed: finalPlaced, unscheduled: result.unscheduled };
  }, [weekStart, viewMode, displayStart, displayEnd, fixedEvents, habits, tasks, eventMap, enrouteBlocks, occurrences, fixedEventOccurrences, habitOccurrences]);

  const itemsByDay = useMemo(() => {
    const map: Record<number, PlacedItem[]> = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
    for (const p of placed) {
      if (p.isAllDay) continue;
      const dayIdx = Math.floor((p.start.getTime() - weekStart.getTime()) / (24 * 60 * 60 * 1000));
      if (dayIdx >= 0 && dayIdx < 7) map[dayIdx].push(p);
    }
    return map;
  }, [placed, weekStart]);

  const allDaySpans = useMemo(() => {
    const dateOnlyUTC = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const weekStartDateOnly = Date.UTC(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate());
    const dayMs = 24 * 60 * 60 * 1000;
    const raw: { item: PlacedItem; startIdx: number; endIdx: number }[] = [];
    for (const p of placed) {
      if (!p.isAllDay) continue;
      const startIdx = Math.round((dateOnlyUTC(p.start) - weekStartDateOnly) / dayMs);
      const endIdxExclusive = Math.round((dateOnlyUTC(p.end) - weekStartDateOnly) / dayMs);
      const endIdx = Math.max(startIdx, endIdxExclusive - 1);
      const clippedStart = Math.max(0, startIdx);
      const clippedEnd = Math.min(6, endIdx);
      if (clippedStart > 6 || clippedEnd < 0) continue;
      raw.push({ item: p, startIdx: clippedStart, endIdx: clippedEnd });
    }
    raw.sort((a, b) => a.startIdx - b.startIdx || a.endIdx - b.endIdx);
    const laneEnds: number[] = [];
    const spans: { item: PlacedItem; startIdx: number; endIdx: number; lane: number }[] = [];
    for (const r of raw) {
      let lane = laneEnds.findIndex((end) => end < r.startIdx);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(r.endIdx);
      } else {
        laneEnds[lane] = r.endIdx;
      }
      spans.push({ ...r, lane });
    }
    return spans;
  }, [placed, weekStart]);

  const allDayLaneCount = Math.max(1, ...allDaySpans.map((s) => s.lane + 1));

  async function syncGoogle() {
    setSyncing(true);
    setSyncMessage(null);
    const status = await getSyncStatus();
    if (!status?.connected) {
      setSyncMessage("Connect Google Calendar in settings first.");
      setSyncing(false);
      return;
    }
    const connections = status.connections as CalendarConnection[];
    const syncRangeStart = addDays(weekStart, -7);
    const pullResult = await pullFromGoogle(syncRangeStart.toISOString(), connections, 42);
    if (!pullResult.success) {
      setSyncMessage(pullResult.error ?? "Google pull failed.");
      setSyncing(false);
      return;
    }
    try {
      await recheckEnrouteBlocks();
    } catch (err) {
      console.error("Enroute recheck after sync failed", err);
    }
    setLastSyncedAt(new Date());
    let pushResult: Awaited<ReturnType<typeof mirrorToGoogle>>;
    try {
      pushResult = await mirrorToGoogle(connections);
    } catch (err) {
      pushResult = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!pushResult.success) {
      setSyncMessage(`Google events were read, but Google Calendar could not be updated: ${pushResult.error ?? "unknown error"}`);
    } else {
      const changes = `${pushResult.created ?? 0} added, ${pushResult.updated ?? 0} updated, ${pushResult.deleted ?? 0} removed`;
      const problems = pushResult.errors && pushResult.errors.length ? ` — ${pushResult.errors.length} item(s) failed: ${pushResult.errors[0]}` : "";
      setSyncMessage(`Synced ${pullResult.eventsPulled ?? 0} events in. Google Calendar: ${changes}.${problems}`);
    }
    setSyncing(false);
  }

  async function deleteItem(item: PlacedItem) {
    if (item.isRecurringOccurrence && item.recurringItemId && item.occurrenceDate) {
      setScopeDialog({ action: "delete", item });
      return;
    }
    const table =
      item.kind === "Fixed Event" ? "fixed_events" : item.kind === "Habit" ? "habits" : "tasks";
    if (item.googleEventId) {
      await deleteFromGoogle(item.kind, item.id);
    }
    await supabase.from(table).delete().eq("id", item.id);
    if (table === "fixed_events") {
      try {
        await recheckEnrouteBlocks();
      } catch (err) {
        console.error("Enroute recheck after delete failed", err);
      }
    }
    loadData();
    scheduleAutoPush();
  }

  async function handleScopedDelete(item: PlacedItem, scope: RecurrenceScope) {
    if (!item.isRecurringOccurrence || !item.recurringItemId || !item.occurrenceDate) return;

    const occTable = item.recurringItemKind === "Fixed Event" ? "fixed_event_occurrences"
      : item.recurringItemKind === "Habit" ? "habit_occurrences"
      : "task_occurrences";
    const idCol = item.recurringItemKind === "Task" ? "task_id" : "item_id";
    const parentTable = item.recurringItemKind === "Fixed Event" ? "fixed_events"
      : item.recurringItemKind === "Habit" ? "habits"
      : "tasks";

    if (scope === "this") {
      const occArr = item.recurringItemKind === "Fixed Event" ? fixedEventOccurrences
        : item.recurringItemKind === "Habit" ? habitOccurrences
        : occurrences;
      const existing = occArr.find((o: any) => o[idCol] === item.recurringItemId && o.occurrence_date === item.occurrenceDate);
      if (existing) {
        await supabase.from(occTable).update({ skipped: true }).eq("id", existing.id);
      } else {
        await supabase.from(occTable).insert({
          [idCol]: item.recurringItemId,
          occurrence_date: item.occurrenceDate,
          skipped: true,
        });
      }
    } else if (scope === "following") {
      const occDate = new Date(item.occurrenceDate + "T00:00:00");
      const dayBefore = new Date(occDate.getTime() - 24 * 60 * 60 * 1000);
      await supabase.from(parentTable).update({
        recurrence_end_mode: "on_date",
        recurrence_end_date: dayBefore.toISOString(),
      }).eq("id", item.recurringItemId);
      const occArr = item.recurringItemKind === "Fixed Event" ? fixedEventOccurrences
        : item.recurringItemKind === "Habit" ? habitOccurrences
        : occurrences;
      const existing = occArr.find((o: any) => o[idCol] === item.recurringItemId && o.occurrence_date === item.occurrenceDate);
      if (existing) {
        await supabase.from(occTable).update({ skipped: true }).eq("id", existing.id);
      } else {
        await supabase.from(occTable).insert({
          [idCol]: item.recurringItemId,
          occurrence_date: item.occurrenceDate,
          skipped: true,
        });
      }
    } else {
      if (item.googleEventId) {
        await deleteFromGoogle(item.recurringItemKind ?? "Task", item.recurringItemId);
      }
      await supabase.from(parentTable).delete().eq("id", item.recurringItemId);
      if (parentTable === "fixed_events") {
        try { await recheckEnrouteBlocks(); } catch {}
      }
    }
    loadData();
    scheduleAutoPush();
  }

  function handleScopedEdit(item: PlacedItem, scope: RecurrenceScope) {
    if (!item.isRecurringOccurrence || !item.recurringItemId) return;

    if (scope === "all") {
      const parent = item.recurringItemKind === "Fixed Event"
        ? fixedEvents.find((e) => e.id === item.recurringItemId)
        : item.recurringItemKind === "Habit"
        ? habits.find((h) => h.id === item.recurringItemId)
        : tasks.find((t) => t.id === item.recurringItemId);
      if (parent) {
        setEditTarget({ kind: item.recurringItemKind as "Fixed Event" | "Habit" | "Task", id: item.recurringItemId, data: parent });
        setSelectedItem(null);
      }
    } else if (scope === "this") {
      const parent = item.recurringItemKind === "Fixed Event"
        ? fixedEvents.find((e) => e.id === item.recurringItemId)
        : item.recurringItemKind === "Habit"
        ? habits.find((h) => h.id === item.recurringItemId)
        : tasks.find((t) => t.id === item.recurringItemId);
      if (parent) {
        setEditTarget({ kind: item.recurringItemKind as "Fixed Event" | "Habit" | "Task", id: item.recurringItemId, data: parent });
        setSelectedItem(null);
      }
    } else {
      const parent = item.recurringItemKind === "Fixed Event"
        ? fixedEvents.find((e) => e.id === item.recurringItemId)
        : item.recurringItemKind === "Habit"
        ? habits.find((h) => h.id === item.recurringItemId)
        : tasks.find((t) => t.id === item.recurringItemId);
      if (parent) {
        setEditTarget({ kind: item.recurringItemKind as "Fixed Event" | "Habit" | "Task", id: item.recurringItemId, data: parent });
        setSelectedItem(null);
      }
    }
  }

  async function updatePillar(item: PlacedItem, pillar: LifePillar | null) {
    const table =
      item.kind === "Fixed Event" ? "fixed_events" : item.kind === "Habit" ? "habits" : "tasks";
    await supabase.from(table).update({ pillar }).eq("id", item.id);
    setSelectedItem((prev) => (prev && prev.id === item.id ? { ...prev, pillar } : prev));
    loadData();
  }

  const [dragItem, setDragItem] = useState<PlacedItem | null>(null);
  const [dragMessage, setDragMessage] = useState<string | null>(null);
  const [overlapConfirm, setOverlapConfirm] = useState<{ item: PlacedItem; newStart: Date; overlapNames: string[] } | null>(null);
  const dragMessageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showDragMessage(msg: string) {
    setDragMessage(msg);
    if (dragMessageTimer.current) clearTimeout(dragMessageTimer.current);
    dragMessageTimer.current = setTimeout(() => setDragMessage(null), 3000);
  }

  async function updateItemTime(item: PlacedItem, newStart: Date) {
    const durationMs = item.end.getTime() - item.start.getTime();
    const newEnd = new Date(newStart.getTime() + durationMs);
    if (item.isRecurringOccurrence && item.recurringItemId && item.occurrenceDate) {
      const occTable = item.recurringItemKind === "Fixed Event" ? "fixed_event_occurrences"
        : item.recurringItemKind === "Habit" ? "habit_occurrences"
        : "task_occurrences";
      const idCol = item.recurringItemKind === "Task" ? "task_id" : "item_id";
      const occArr = item.recurringItemKind === "Fixed Event" ? fixedEventOccurrences
        : item.recurringItemKind === "Habit" ? habitOccurrences
        : occurrences;
      const existing = occArr.find((o: any) => o[idCol] === item.recurringItemId && o.occurrence_date === item.occurrenceDate);
      if (existing) {
        await supabase.from(occTable).update({
          override_start: newStart.toISOString(),
          override_end: newEnd.toISOString(),
        }).eq("id", existing.id);
      } else {
        await supabase.from(occTable).insert({
          [idCol]: item.recurringItemId,
          occurrence_date: item.occurrenceDate,
          override_start: newStart.toISOString(),
          override_end: newEnd.toISOString(),
        });
      }
      return;
    }
    const table =
      item.kind === "Fixed Event" ? "fixed_events" : item.kind === "Habit" ? "habits" : "tasks";
    if (item.kind === "Fixed Event") {
      await supabase.from(table).update({
        start_time: newStart.toISOString(),
        end_time: newEnd.toISOString(),
      }).eq("id", item.id);
    } else if (item.kind === "Habit") {
      const searchEnd = new Date(newStart.getTime() + durationMs);
      await supabase.from(table).update({
        search_start: newStart.toISOString(),
        search_end: searchEnd.toISOString(),
      }).eq("id", item.id);
    } else {
      const deadline = new Date(newStart.getTime() + durationMs);
      await supabase.from(table).update({
        search_start: newStart.toISOString(),
        deadline: deadline.toISOString(),
      }).eq("id", item.id);
    }
  }

  async function updateItemDuration(item: PlacedItem, newEnd: Date) {
    if (item.isRecurringOccurrence && item.recurringItemId && item.occurrenceDate) {
      const occTable = item.recurringItemKind === "Fixed Event" ? "fixed_event_occurrences"
        : item.recurringItemKind === "Habit" ? "habit_occurrences"
        : "task_occurrences";
      const idCol = item.recurringItemKind === "Task" ? "task_id" : "item_id";
      const occArr = item.recurringItemKind === "Fixed Event" ? fixedEventOccurrences
        : item.recurringItemKind === "Habit" ? habitOccurrences
        : occurrences;
      const existing = occArr.find((o: any) => o[idCol] === item.recurringItemId && o.occurrence_date === item.occurrenceDate);
      if (existing) {
        await supabase.from(occTable).update({ override_end: newEnd.toISOString() }).eq("id", existing.id);
      } else {
        await supabase.from(occTable).insert({
          [idCol]: item.recurringItemId,
          occurrence_date: item.occurrenceDate,
          override_start: item.start.toISOString(),
          override_end: newEnd.toISOString(),
        });
      }
      return;
    }
    const table = item.kind === "Fixed Event" ? "fixed_events" : item.kind === "Habit" ? "habits" : "tasks";
    if (item.kind === "Fixed Event") {
      await supabase.from(table).update({ end_time: newEnd.toISOString() }).eq("id", item.id);
    } else if (item.kind === "Habit") {
      const searchEnd = new Date(newEnd);
      await supabase.from(table).update({ search_end: searchEnd.toISOString() }).eq("id", item.id);
    } else {
      await supabase.from(table).update({ deadline: newEnd.toISOString() }).eq("id", item.id);
    }
  }

  function handleResizeStart(e: React.MouseEvent, item: PlacedItem) {
    e.stopPropagation();
    e.preventDefault();
    setResizeState({ item, startY: e.clientY, originalEnd: item.end, previewEnd: item.end });
  }

  useEffect(() => {
    if (!resizeState) return;
    const onMove = (e: MouseEvent) => {
      const deltaMs = (e.clientY - resizeState.startY) * (60 / SLOT_PX) * 60 * 1000;
      const newEnd = new Date(resizeState.originalEnd.getTime() + deltaMs);
      const snapped = snapToSlot(newEnd);
      const minEnd = new Date(resizeState.item.start.getTime() + 15 * 60 * 1000);
      if (snapped < minEnd) return;
      if (isQuietTime(resizeState.item.start, snapped)) return;
      if (resizeState.item.pillar && HOME_ONLY_PILLARS.includes(resizeState.item.pillar) && isUTADay(resizeState.item.start, fixedEvents)) return;
      setResizeState((prev) => (prev ? { ...prev, previewEnd: snapped } : null));
    };
    const onUp = async () => {
      const rs = resizeState;
      if (rs && rs.previewEnd.getTime() !== rs.originalEnd.getTime()) {
        await updateItemDuration(rs.item, rs.previewEnd);
        loadData();
        scheduleAutoPush();
      }
      setResizeState(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizeState]);

  async function handleDrop(targetDate: Date) {
    const item = dragItem;
    setDragItem(null);
    if (!item) return;

    const newStart = snapToSlot(targetDate);
    const durationMs = item.end.getTime() - item.start.getTime();
    const newEnd = new Date(newStart.getTime() + durationMs);

    if (newStart.getTime() === item.start.getTime() && newStart.getDate() === item.start.getDate()) {
      return;
    }

    if (isQuietTime(newStart, newEnd)) {
      showDragMessage("Can't schedule between 9 PM and 9 AM");
      return;
    }

    if (item.pillar && HOME_ONLY_PILLARS.includes(item.pillar) && isUTADay(newStart, fixedEvents)) {
      showDragMessage("Can't schedule Family-pillar items on UTA days");
      return;
    }

    const enrouteItems = placed.filter((p) => p.kind === "Enroute");
    for (const er of enrouteItems) {
      if (rangesOverlap(newStart, newEnd, er.start, er.end)) {
        showDragMessage("Can't drop on an Enroute block");
        return;
      }
    }

    const overlaps = placed.filter((p) =>
      p.id !== item.id &&
      p.kind !== "Enroute" &&
      rangesOverlap(newStart, newEnd, p.start, p.end)
    );

    if (overlaps.length > 0) {
      setOverlapConfirm({
        item,
        newStart,
        overlapNames: overlaps.map((o) => o.name),
      });
      return;
    }

    await updateItemTime(item, newStart);
    loadData();
    scheduleAutoPush();
  }

  async function confirmOverlapMove() {
    if (!overlapConfirm) return;
    const { item, newStart } = overlapConfirm;
    setOverlapConfirm(null);

    const durationMin = Math.round((item.end.getTime() - item.start.getTime()) / 60000);
    const overlapping = placed.filter((p) =>
      p.id !== item.id &&
      p.kind !== "Enroute" &&
      rangesOverlap(newStart, new Date(newStart.getTime() + durationMin * 60000), p.start, p.end)
    );

    await updateItemTime(item, newStart);

    for (const other of overlapping) {
      const nextSlot = findNextFreeSlot(other, newStart, Math.round((other.end.getTime() - other.start.getTime()) / 60000), placed, fixedEvents);
      if (nextSlot) {
        await updateItemTime(other, nextSlot);
      }
    }

    loadData();
    scheduleAutoPush();
  }

  const weekEnd = addDays(weekStart, 6);
  const mobileDate = addDays(weekStart, mobileDayIndex);
  const mobileIsToday = mobileDate.toDateString() === new Date().toDateString();
  const stats = {
    fixed: placed.filter((p) => p.kind === "Fixed Event").length,
    habits: placed.filter((p) => p.kind === "Habit").length,
    tasks: placed.filter((p) => p.kind === "Task").length,
    unscheduled: unscheduled.length,
  };

  const syncFreshness = getSyncFreshness(lastSyncedAt);

  return (
    <>
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-30">
        <div className="px-4 sm:px-6 py-3 flex items-center gap-3">
          {/* Logo + title */}
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-emerald-500 flex items-center justify-center">
              <CalendarDays className="w-4 h-4 text-white" />
            </div>
            <div className="hidden sm:block">
              <h1 className="text-base font-semibold tracking-tight leading-tight">Smart Scheduler</h1>
              <p className="text-[11px] text-slate-400 leading-tight">Priority-aware weekly calendar</p>
            </div>
          </div>

          {/* Spacer */}
          <div className="flex-1 flex flex-wrap items-center justify-end gap-2 gap-y-2 min-w-0">

          {/* Week/month navigation (tablet/desktop) */}
          <div className={layout === "desktop" ? "flex items-center gap-1 shrink-0" : "hidden"}>
            <button
              onClick={() => {
                if (viewMode === "month") {
                  setWeekStart(new Date(weekStart.getFullYear(), weekStart.getMonth() - 1, 1));
                } else {
                  setWeekStart(addDays(weekStart, -7));
                }
              }}
              className="p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
              aria-label={viewMode === "month" ? "Previous month" : "Previous week"}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="text-xs sm:text-sm font-medium min-w-[120px] sm:min-w-[160px] text-center tabular-nums">
              {viewMode === "month"
                ? weekStart.toLocaleDateString("en-US", { month: "long", year: "numeric" })
                : `${formatDay(weekStart)} — ${formatDay(weekEnd)}`}
            </div>
            <button
              onClick={() => {
                if (viewMode === "month") {
                  setWeekStart(new Date(weekStart.getFullYear(), weekStart.getMonth() + 1, 1));
                } else {
                  setWeekStart(addDays(weekStart, 7));
                }
              }}
              className="p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
              aria-label={viewMode === "month" ? "Next month" : "Next week"}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Day navigation (mobile) */}
          <div className={layout === "mobile" ? "flex items-center gap-1 shrink-0" : "hidden"}>
            <button
              onClick={() => {
                if (mobileDayIndex === 0) {
                  setWeekStart(addDays(weekStart, -7));
                  setMobileDayIndex(6);
                } else {
                  setMobileDayIndex(mobileDayIndex - 1);
                }
              }}
              className="p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
              aria-label="Previous day"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className={`text-xs font-medium min-w-[100px] text-center tabular-nums ${mobileIsToday ? "text-blue-400" : ""}`}>
              {mobileDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
            </div>
            <button
              onClick={() => {
                if (mobileDayIndex === 6) {
                  setWeekStart(addDays(weekStart, 7));
                  setMobileDayIndex(0);
                } else {
                  setMobileDayIndex(mobileDayIndex + 1);
                }
              }}
              className="p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
              aria-label="Next day"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1.5 shrink-0 ml-1">
            <button
              onClick={() => {
                setWeekStart(getWeekStart(new Date()));
                setMobileDayIndex((new Date().getDay() + 6) % 7);
              }}
              className="px-2.5 py-1.5 text-xs rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors"
            >
              Today
            </button>
            {/* Week/Month view toggle (desktop only) */}
            {layout === "desktop" && (
              <div className="flex items-center rounded-lg bg-slate-800 overflow-hidden">
                <button
                  onClick={() => setViewMode("week")}
                  className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    viewMode === "week" ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  Week
                </button>
                <button
                  onClick={() => setViewMode("month")}
                  className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    viewMode === "month" ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  Month
                </button>
              </div>
            )}
            {/* Mini month navigator */}
            <div className="relative">
              <button
                onClick={() => setShowMiniMonth(!showMiniMonth)}
                className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors"
                aria-label="Jump to date"
                title="Jump to date"
              >
                <Calendar className="w-3.5 h-3.5" />
              </button>
              {showMiniMonth && (
                <MiniMonthNavigator
                  weekStart={weekStart}
                  viewMode={viewMode}
                  onPick={(date) => {
                    setWeekStart(getWeekStart(date));
                    setMobileDayIndex((date.getDay() + 6) % 7);
                    setShowMiniMonth(false);
                  }}
                  onClose={() => setShowMiniMonth(false)}
                />
              )}
            </div>
            <button
              onClick={() => void syncGoogle()}
              disabled={syncing}
              className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50"
              aria-label="Sync Google Calendar"
              title="Sync Google Calendar"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
            </button>
            <button
              onClick={() => void recheckFlights()}
              disabled={recheckingEnroute}
              className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50"
              aria-label="Recheck flights"
              title="Recheck flights (rebuild Enroute drive-time blocks)"
            >
              <Plane className={`w-3.5 h-3.5 ${recheckingEnroute ? "animate-pulse" : ""}`} />
            </button>
            {/* Force desktop/mobile layout switcher (always visible, overrides auto-detection) */}
            <button
              onClick={toggleViewMode}
              className={`relative p-2.5 rounded-full text-white transition-colors shadow-md ${
                isOverridden ? "bg-blue-600 hover:bg-blue-500" : "bg-slate-700 hover:bg-slate-600"
              }`}
              aria-label={
                (layout === "mobile" ? "Switch to desktop view" : "Switch to mobile view") +
                (isOverridden ? " (manually set, tap to change)" : " (auto)")
              }
              title={
                (layout === "mobile" ? "Switch to desktop view" : "Switch to mobile view") +
                (isOverridden ? " — manually set, tap to change" : " — following screen size automatically")
              }
            >
              {layout === "mobile" ? (
                <Monitor className="w-5 h-5" />
              ) : (
                <Smartphone className="w-5 h-5" />
              )}
              {isOverridden && (
                <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-amber-400 border-2 border-slate-900" />
              )}
            </button>
            {/* Settings: visible on sm+, overflow on mobile */}
            <button
              onClick={() => setShowConnections(true)}
              className={layout === "desktop" ? "hidden sm:flex p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors" : "hidden"}
              aria-label="Open calendar connections"
              title="Google Calendar connections"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setShowAdd(true)}
              className="px-2.5 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 transition-colors flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              <span className={layout === "desktop" ? "hidden sm:inline" : "hidden"}>Add Item</span>
            </button>
            {/* Overflow menu (mobile only) */}
            <div className={layout === "mobile" ? "relative" : "relative sm:hidden"}>
              <button
                onClick={() => setShowOverflow(!showOverflow)}
                className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 transition-colors"
                aria-label="More actions"
              >
                <MoreVertical className="w-3.5 h-3.5" />
              </button>
              {showOverflow && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowOverflow(false)} />
                  <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-slate-800 border border-slate-700 rounded-lg shadow-xl py-1">
                    <button
                      onClick={() => { setShowConnections(true); setShowOverflow(false); }}
                      className="w-full px-3 py-2 text-left text-xs text-slate-300 hover:bg-slate-700 flex items-center gap-2"
                    >
                      <Settings className="w-3.5 h-3.5" />
                      Calendar Settings
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          </div>
        </div>

        {/* Stats bar */}
        <div className="px-4 sm:px-6 pb-3 flex items-center gap-4 text-xs">
          {syncMessage && <span className="text-blue-300">{syncMessage}</span>}
              {recheckMessage && <span className="text-emerald-300">{recheckMessage}</span>}
          <span className={`flex items-center gap-1.5 ${syncFreshness.colorClass}`}>
            <RefreshCw className="w-3 h-3" />
            Synced {syncFreshness.label}
          </span>
          <span className="flex items-center gap-1.5 text-slate-400">
            <span className="w-2 h-2 rounded-full bg-slate-500"></span>
            {stats.fixed} Fixed
          </span>
          <span className="flex items-center gap-1.5 text-slate-400">
            <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
            {stats.habits} Habits
          </span>
          <span className="flex items-center gap-1.5 text-slate-400">
            <span className="w-2 h-2 rounded-full bg-blue-500"></span>
            {stats.tasks} Tasks
          </span>
          {stats.unscheduled > 0 && (
            <span className="flex items-center gap-1.5 text-amber-400">
              <AlertTriangle className="w-3 h-3" />
              {stats.unscheduled} Unscheduled
            </span>
          )}
        </div>
      </header>

      {/* Calendar */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-96 text-slate-500">
            <div className="animate-pulse">Loading schedule…</div>
          </div>
        ) : (
          <div className={layout === "desktop" ? "inline-flex flex-col min-w-full" : "hidden"}>
            {viewMode === "month" ? (
              /* Month grid view */
              <MonthGrid
                monthGridStart={monthGridStart}
                placed={placed}
                onPickDate={(date) => {
                  setViewMode("week");
                  setWeekStart(getWeekStart(date));
                  setMobileDayIndex((date.getDay() + 6) % 7);
                }}
                onPickItem={setSelectedItem}
              />
            ) : (
              <>
            {/* Day headers */}
            <div className="flex sticky top-0 z-20 bg-slate-900 border-b border-slate-800">
              <div className="w-14 shrink-0 border-r border-slate-800" />
              {DAYS.map((day, i) => {
                const date = addDays(weekStart, i);
                const isToday =
                  date.toDateString() === new Date().toDateString();
                return (
                  <div
                    key={day}
                    className="flex-1 min-w-[140px] px-3 py-2.5 border-r border-slate-800 last:border-r-0"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                        {day}
                      </span>
                      <span
                        className={`text-sm font-semibold ${
                          isToday ? "text-blue-400" : "text-slate-300"
                        }`}
                      >
                        {date.getDate()}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* All-day events row */}
            <div className="flex border-b border-slate-800 bg-slate-900/50">
              <div className="w-14 shrink-0 border-r border-slate-800 flex items-center justify-end pr-2 py-1">
                <span className="text-[10px] text-slate-500 uppercase tracking-wide">All day</span>
              </div>
              <div
                className="flex-1 relative"
                style={{ minHeight: `${allDayLaneCount * 22 + 8}px` }}
              >
                <div className="absolute inset-0 flex pointer-events-none">
                  {DAYS.map((_, dayIdx) => (
                    <div
                      key={dayIdx}
                      className="flex-1 min-w-[140px] border-r border-slate-800 last:border-r-0"
                    />
                  ))}
                </div>
                {allDaySpans.map((span, idx) => {
                  const item = span.item;
                  const colors = getPillarColor(item.pillar);
                  const leftPct = (span.startIdx / 7) * 100;
                  const widthPct = ((span.endIdx - span.startIdx + 1) / 7) * 100;
                  return (
                    <div
                      key={`${item.id}-${idx}`}
                      className={`absolute rounded ${colors.bg} px-1.5 py-0.5 text-left overflow-hidden cursor-pointer group hover:z-10 hover:brightness-110 transition-all shadow-sm`}
                      style={{
                        left: `calc(${leftPct}% + 2px)`,
                        width: `calc(${widthPct}% - 4px)`,
                        top: `${span.lane * 22 + 4}px`,
                        height: "20px",
                      }}
                    >
                      <button
                        onClick={() => setSelectedItem(item)}
                        className="w-full h-full text-left flex items-center gap-1"
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${colors.dot} shrink-0`} />
                        <span className="text-[11px] font-medium truncate text-white">
                          {item.name}
                        </span>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteItem(item);
                        }}
                        className="absolute top-0.5 right-0.5 p-0.5 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/20 transition-colors opacity-0 group-hover:opacity-100"
                        aria-label="Delete item"
                      >
                        <Trash2 className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>{/* Time grid */}
            <div className="flex">
              {/* Hour labels */}
              <div className="w-14 shrink-0 border-r border-slate-800">
                {HOURS.map((h) => (
                  <div
                    key={h}
                    className="h-16 flex items-start justify-end pr-2 pt-1 text-xs text-slate-500"
                  >
                    {h === 0
                      ? "12 AM"
                      : h === 12
                      ? "12 PM"
                      : h > 12
                      ? `${h - 12} PM`
                      : `${h} AM`}
                  </div>
                ))}
              </div>

              {/* Day columns */}
              {DAYS.map((_, dayIdx) => (
                <div
                  key={dayIdx}
                  className="flex-1 min-w-[140px] border-r border-slate-800 last:border-r-0 relative"
                >
                  {/* Hour rows */}
                  {HOURS.map((h) => (
                    <div
                      key={h}
                      className="h-16 border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors cursor-pointer"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const y = e.clientY - rect.top;
                        const slot = Math.floor(y / 16) * 15;
                        const start = new Date(addDays(weekStart, dayIdx));
                        start.setHours(h, slot, 0, 0);
                        setAddPrefillDate(start);
                        setShowAdd(true);
                      }}
                      onDragOver={(e) => { if (dragItem) e.preventDefault(); }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!dragItem) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        const y = e.clientY - rect.top;
                        const slot = Math.floor(y / SLOT_PX) * SLOT_MIN;
                        const start = new Date(addDays(weekStart, dayIdx));
                        start.setHours(h, slot, 0, 0);
                        handleDrop(start);
                      }}
                    />
                  ))}

                  {/* Placed items */}
                  {itemsByDay[dayIdx].map((item, idx) => {
                    const effectiveEnd = resizeState && resizeState.item.id === item.id ? resizeState.previewEnd : item.end;
                    const topOffset =
                      ((item.start.getHours() - GRID_START_HOUR) * 60 +
                        item.start.getMinutes()) *
                      (64 / 60);
                    const height = Math.max(
                      20,
                      ((effectiveEnd.getTime() - item.start.getTime()) /
                        (1000 * 60)) *
                        (64 / 60) -
                        2
                    );
                    const colors = getPillarColor(item.pillar);
                    const isFixed = item.kind === "Fixed Event";
                    const isDisplayOnly = isFixed && item.blocksSchedule === false;
                    const isEnroute = item.kind === "Enroute";

                    return (
                      <div
                        key={`${item.id}-${idx}`}
                        draggable={!isEnroute}
                        onDragStart={(e) => { if (!isEnroute) { setDragItem(item); e.dataTransfer.effectAllowed = "move"; } }}
                        onDragEnd={() => setDragItem(null)}
                        className={`absolute left-1 right-1 rounded-md ${colors.soft} ${colors.border} border-l-2 px-2 py-1 text-left overflow-hidden group ${isEnroute ? "border-dashed" : "hover:z-10 hover:scale-[1.02] transition-transform cursor-pointer"} ${isDisplayOnly ? "opacity-60 border-dashed" : ""}`}
                        style={{ top: `${topOffset}px`, height: `${height}px`}}
                      >
                        <button
                          onClick={isEnroute ? undefined : () => setSelectedItem(item)}
                          className={isEnroute ? "w-full text-left cursor-default" : "w-full text-left"}
                        >
                          <div className="flex items-center gap-1">
                            <span className={`w-1.5 h-1.5 rounded-full ${colors.dot} shrink-0`} />
                            <span
                              className={`text-[11px] font-medium truncate ${
                                isFixed ? "text-slate-300" : "text-slate-100"
                              }`}
                            >
                              {item.name}
                            </span>
                          </div>
                          <div className="text-[10px] text-slate-400 mt-0.5">
                            {formatTimeRange(item.start, effectiveEnd)}
                          </div>
                          {item.isBatch && (
                            <div className="flex items-center gap-0.5 mt-0.5">
                              <Layers className="w-2.5 h-2.5 text-slate-400" />
                              <span className="text-[9px] text-slate-500">
                                batched
                              </span>
                            </div>
                          )}
                        </button>
                        {!isEnroute && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteItem(item);
                          }}
                          className="absolute top-1 right-1 p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/20 transition-colors opacity-0 group-hover:opacity-100"
                          aria-label="Delete item"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                        )}
                        {!isEnroute && !isDisplayOnly && (
                          <div
                            onMouseDown={(e) => handleResizeStart(e, item)}
                            className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-slate-400/40 transition-colors"
                            style={{ touchAction: "none" }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
              </>
            )}
          </div>
        )}
          {/* Mobile single-day view */}
          <div className={layout === "mobile" ? "flex flex-col" : "hidden"}>
            {allDaySpans.filter((s) => mobileDayIndex >= s.startIdx && mobileDayIndex <= s.endIdx).length > 0 && (
              <div className="border-b border-slate-800 bg-slate-900/50 px-3 py-2 space-y-1">
                {allDaySpans
                  .filter((s) => mobileDayIndex >= s.startIdx && mobileDayIndex <= s.endIdx)
                  .map((span, idx) => {
                    const item = span.item;
                    const colors = getPillarColor(item.pillar);
                    return (
                      <button
                        key={`${item.id}-${idx}`}
                        onClick={() => setSelectedItem(item)}
                        className={`w-full flex items-center gap-1.5 rounded px-2 py-1 text-left ${colors.bg}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${colors.dot} shrink-0`} />
                        <span className="text-xs font-medium truncate text-white">{item.name}</span>
                      </button>
                    );
                  })}
              </div>
            )}
            <div className="flex">
              <div className="w-12 shrink-0 border-r border-slate-800">
                {HOURS.map((h) => (
                  <div
                    key={h}
                    className="h-16 flex items-start justify-end pr-1.5 pt-1 text-[11px] text-slate-500"
                  >
                    {h === 0
                      ? "12 AM"
                      : h === 12
                      ? "12 PM"
                      : h > 12
                      ? `${h - 12} PM`
                      : `${h} AM`}
                  </div>
                ))}
              </div>
              <div className="flex-1 relative">
                {HOURS.map((h) => (
                  <div
                    key={h}
                    className="h-16 border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors cursor-pointer"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const y = e.clientY - rect.top;
                      const slot = Math.floor(y / 16) * 15;
                      const start = new Date(mobileDate);
                      start.setHours(h, slot, 0, 0);
                      setAddPrefillDate(start);
                      setShowAdd(true);
                    }}
                    onDragOver={(e) => { if (dragItem) e.preventDefault(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (!dragItem) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      const y = e.clientY - rect.top;
                      const slot = Math.floor(y / SLOT_PX) * SLOT_MIN;
                      const start = new Date(mobileDate);
                      start.setHours(h, slot, 0, 0);
                      handleDrop(start);
                    }}
                  />
                ))}
                {itemsByDay[mobileDayIndex].map((item, idx) => {
                  const effectiveEnd = resizeState && resizeState.item.id === item.id ? resizeState.previewEnd : item.end;
                  const topOffset =
                    ((item.start.getHours() - GRID_START_HOUR) * 60 +
                      item.start.getMinutes()) *
                    (64 / 60);
                  const height = Math.max(
                    20,
                    ((effectiveEnd.getTime() - item.start.getTime()) /
                      (1000 * 60)) *
                      (64 / 60) -
                      2
                  );
                  const colors = getPillarColor(item.pillar);
                  const isFixed = item.kind === "Fixed Event";
                  const isDisplayOnly = isFixed && item.blocksSchedule === false;
                  return (
                    <div
                      key={`${item.id}-${idx}`}
                      draggable
                      onDragStart={(e) => { setDragItem(item); e.dataTransfer.effectAllowed = "move"; }}
                      onDragEnd={() => setDragItem(null)}
                      className={`absolute left-1 right-1 rounded-md ${colors.soft} ${colors.border} border-l-2 overflow-hidden ${isDisplayOnly ? "opacity-60 border-dashed" : ""}`}
                      style={{ top: `${topOffset}px`, height: `${height}px` }}
                    >
                      <button
                        onClick={() => setSelectedItem(item)}
                        className="w-full h-full text-left px-2 py-1"
                      >
                        <div className="flex items-center gap-1">
                          <span className={`w-1.5 h-1.5 rounded-full ${colors.dot} shrink-0`} />
                          <span
                            className={`text-xs font-medium truncate ${
                              isFixed ? "text-slate-300" : "text-slate-100"
                            }`}
                          >
                            {item.name}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          {formatTimeRange(item.start, effectiveEnd)}
                        </div>
                      </button>
                      {!isDisplayOnly && (
                        <div
                          onMouseDown={(e) => handleResizeStart(e, item)}
                          className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize hover:bg-slate-400/40 transition-colors"
                          style={{ touchAction: "none" }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
      </div>

      {/* Unscheduled panel */}
      {unscheduled.length > 0 && (
        <div className="border-t border-slate-800 bg-slate-900/50 px-6 py-3">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-medium text-amber-400">
              {unscheduled.length} item{unscheduled.length > 1 ? "s" : ""} couldn't fit
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {unscheduled.map((u) => (
              <div
                key={u.id}
                className="px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-center gap-2"
              >
                <span className="font-medium">{u.name}</span>
                <span className="text-amber-500/70">
                  {TIER_LABELS[u.tier]} · due {formatTime(u.deadline)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {showConnections && <CalendarConnectionsPanel onClose={() => setShowConnections(false)} />}

      {/* Add modal */}
      {showAdd && (
        <AddItemModal
          weekStart={weekStart}
          onClose={() => { setShowAdd(false); setAddPrefillDate(null); }}
          onSaved={loadData}
          prefillDate={addPrefillDate}
        />
      )}

      {/* Item detail popover */}
      {selectedItem && (
        <ItemDetail
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
          onDelete={() => {
            if (selectedItem.isRecurringOccurrence) {
              setScopeDialog({ action: "delete", item: selectedItem });
              setSelectedItem(null);
            } else {
              deleteItem(selectedItem);
              setSelectedItem(null);
            }
          }}
          onEdit={() => {
            if (selectedItem.isRecurringOccurrence) {
              setScopeDialog({ action: "edit", item: selectedItem });
              setSelectedItem(null);
            } else {
              const target = selectedItem.kind === "Fixed Event"
                ? fixedEvents.find((e) => e.id === selectedItem.id)
                : selectedItem.kind === "Habit"
                ? habits.find((h) => h.id === selectedItem.id)
                : tasks.find((t) => t.id === selectedItem.id);
              if (target) {
                setEditTarget({ kind: selectedItem.kind as "Fixed Event" | "Habit" | "Task", id: selectedItem.id, data: target });
              }
              setSelectedItem(null);
            }
          }}
          onSetPillar={(p) => updatePillar(selectedItem, p)}
        />
      )}

      {editTarget && (
        <AddItemModal
          weekStart={weekStart}
          onClose={() => setEditTarget(null)}
          onSaved={loadData}
          editTarget={editTarget}
        />
      )}

      {scopeDialog && (
        <ScopeDialog
          action={scopeDialog.action}
          itemName={scopeDialog.item.name}
          onCancel={() => setScopeDialog(null)}
          onSelect={(scope) => {
            if (scopeDialog.action === "delete") {
              handleScopedDelete(scopeDialog.item, scope);
            } else {
              handleScopedEdit(scopeDialog.item, scope);
            }
            setScopeDialog(null);
          }}
        />
      )}

      {/* Drag inline message */}
      {dragMessage && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-rose-500/90 text-white text-sm font-medium shadow-lg">
          {dragMessage}
        </div>
      )}

      {/* Overlap confirmation dialog */}
      {overlapConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          onClick={() => setOverlapConfirm(null)}
        >
          <div
            className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
              <h3 className="text-base font-semibold">Time conflict</h3>
            </div>
            <p className="text-sm text-slate-300 mb-2">
              This overlaps with:
            </p>
            <ul className="text-sm text-slate-400 mb-4 space-y-1">
              {overlapConfirm.overlapNames.map((n, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                  {n}
                </li>
              ))}
            </ul>
            <p className="text-xs text-slate-500 mb-4">
              Continuing will place your item here and automatically move the conflicting item(s) to the next free slot.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setOverlapConfirm(null)}
                className="flex-1 py-2.5 rounded-lg bg-slate-800 text-slate-300 text-sm font-medium hover:bg-slate-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => confirmOverlapMove()}
                className="flex-1 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 transition-colors"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ItemDetail({
  item,
  onClose,
  onDelete,
  onEdit,
  onSetPillar,
}: {
  item: PlacedItem;
  onClose: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onSetPillar: (p: LifePillar | null) => void;
}) {
  const colors = getPillarColor(item.pillar);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${colors.dot}`} />
            <span className="text-xs text-slate-400 uppercase tracking-wide">
              {item.kind}
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>
        <h3 className="text-lg font-semibold mb-3">{item.name}</h3>
        <div className="space-y-2 text-sm text-slate-300">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-500" />
            {item.isAllDay ? "All day" : `${formatTime(item.start)} — ${formatTime(item.end)}`}
          </div>
          {item.recurrenceSummary && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Repeat className="w-3.5 h-3.5" />
              {item.recurrenceSummary}
            </div>
          )}
          {item.blocksSchedule === false && (
            <div className="rounded-lg bg-slate-800/70 px-3 py-2 text-xs text-slate-400">Display-only event — this time remains available for scheduling.</div>
          )}
          {item.tier > 0 && (
            <div className="flex items-center gap-2">
              <GripVertical className="w-4 h-4 text-slate-500" />
              {TIER_LABELS[item.tier]}
            </div>
          )}
          <div className="flex items-center gap-2 text-xs text-slate-500">
            Context: {item.context}
          </div>
          {!item.isBatch && (
            <div className="pt-1">
              <div className="text-xs text-slate-500 mb-1.5">Pillar</div>
              <div className="flex gap-1.5 flex-wrap">
                <button
                  onClick={() => onSetPillar(null)}
                  className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-all ${
                    !item.pillar
                      ? "bg-slate-600 text-white border-transparent"
                      : "bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600"
                  }`}
                >
                  Unassigned
                </button>
                {PILLARS.map((p) => {
                  const pc = PILLAR_COLORS[p];
                  return (
                    <button
                      key={p}
                      onClick={() => onSetPillar(p)}
                      className={`px-2 py-1 rounded-md text-[11px] font-medium border transition-all ${
                        item.pillar === p
                          ? `${pc.bg} ${pc.text} border-transparent`
                          : "bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600"
                      }`}
                    >
                      {PILLAR_LABELS[p]}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {item.isBatch && item.memberNames && (
            <div className="pt-2 border-t border-slate-800">
              <div className="flex items-center gap-2 mb-1">
                <Layers className="w-4 h-4 text-slate-500" />
                <span className="text-xs text-slate-400">Batched tasks:</span>
              </div>
              <ul className="text-xs text-slate-400 ml-6 list-disc">
                {item.memberNames.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {item.googleEventId && (
          <div className="flex items-center gap-2 text-xs text-slate-500 pt-1">
            <span className="text-blue-400">Linked to Google Calendar</span>
          </div>
        )}
        <button
          onClick={onEdit}
          className="mt-4 w-full py-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-400 text-sm font-medium hover:bg-blue-500/20 transition-colors flex items-center justify-center gap-2"
        >
          <Pencil className="w-4 h-4" />
          Edit
        </button>
        <button
          onClick={onDelete}
          className="mt-4 w-full py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-sm font-medium hover:bg-rose-500/20 transition-colors flex items-center justify-center gap-2"
        >
          <Trash2 className="w-4 h-4" />
          Delete
        </button>
      </div>
    </div>
  );
}

function ScopeDialog({
  action,
  itemName,
  onCancel,
  onSelect,
}: {
  action: "delete" | "edit";
  itemName: string;
  onCancel: () => void;
  onSelect: (scope: RecurrenceScope) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-2">
          {action === "delete" ? "Delete recurring item" : "Edit recurring item"}
        </h3>
        <p className="text-xs text-slate-400 mb-4">{itemName}</p>
        <div className="space-y-2">
          <button
            onClick={() => onSelect("this")}
            className="w-full py-2.5 rounded-lg bg-slate-800 text-slate-200 text-sm font-medium hover:bg-slate-700 transition-colors text-left px-4"
          >
            This event
          </button>
          <button
            onClick={() => onSelect("following")}
            className="w-full py-2.5 rounded-lg bg-slate-800 text-slate-200 text-sm font-medium hover:bg-slate-700 transition-colors text-left px-4"
          >
            This and following events
          </button>
          <button
            onClick={() => onSelect("all")}
            className="w-full py-2.5 rounded-lg bg-slate-800 text-slate-200 text-sm font-medium hover:bg-slate-700 transition-colors text-left px-4"
          >
            All events
          </button>
        </div>
        <button
          onClick={onCancel}
          className="w-full mt-3 py-2.5 rounded-lg bg-slate-800 text-slate-400 text-sm font-medium hover:bg-slate-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function MonthGrid({
  monthGridStart,
  placed,
  onPickDate,
  onPickItem,
}: {
  monthGridStart: Date;
  placed: PlacedItem[];
  onPickDate: (date: Date) => void;
  onPickItem: (item: PlacedItem) => void;
}) {
  const [detailDay, setDetailDay] = useState<{ date: Date; items: PlacedItem[] } | null>(null);
  const today = new Date();
  const todayStr = today.toDateString();
  const currentMonth = monthGridStart.getMonth() === new Date(monthGridStart.getFullYear(), monthGridStart.getMonth(), 1).getMonth()
    ? monthGridStart.getMonth()
    : new Date(monthGridStart.getFullYear(), monthGridStart.getMonth() + 1, 0).getMonth();

  // Build 42 cells
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(monthGridStart, i));

  // Group items by their date (not day-of-week index)
  const itemsByDate = useMemo(() => {
    const map = new Map<string, PlacedItem[]>();
    for (const p of placed) {
      if (p.isAllDay) continue; // all-day items shown in the all-day row in week view
      const dateKey = formatLocalDate(p.start);
      if (!map.has(dateKey)) map.set(dateKey, []);
      map.get(dateKey)!.push(p);
    }
    return map;
  }, [placed]);

  return (
    <div className="flex flex-col min-w-full">
      {/* Day-of-week headers */}
      <div className="flex sticky top-0 z-20 bg-slate-900 border-b border-slate-800">
        {DAYS.map((day) => (
          <div
            key={day}
            className="flex-1 min-w-[120px] px-3 py-2 border-r border-slate-800 last:border-r-0"
          >
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wide">
              {day}
            </span>
          </div>
        ))}
      </div>
      {/* 6 rows x 7 cols grid */}
      <div className="grid grid-cols-7">
        {cells.map((date, i) => {
          const dateKey = formatLocalDate(date);
          const dayItems = itemsByDate.get(dateKey) ?? [];
          const isToday = date.toDateString() === todayStr;
          const isCurrentMonth = date.getMonth() === currentMonth;
          return (
            <div
              key={i}
              className={`min-h-[100px] border-r border-b border-slate-800 p-1.5 flex flex-col gap-0.5 ${
                isCurrentMonth ? "bg-slate-900/30" : "bg-slate-900/60"
              } ${isToday ? "ring-1 ring-blue-500 ring-inset" : ""}`}
            >
              <button
                onClick={() => onPickDate(date)}
                className={`text-xs font-semibold self-start px-1.5 rounded hover:bg-slate-700 transition-colors ${
                  isToday
                    ? "bg-blue-600 text-white"
                    : isCurrentMonth
                    ? "text-slate-300"
                    : "text-slate-600"
                }`}
              >
                {date.getDate()}
              </button>
              <div className="flex flex-col gap-0.5 overflow-hidden">
                {dayItems.slice(0, 3).map((item, idx) => {
                  const colors = getPillarColor(item.pillar);
                  return (
                    <button
                      key={`${item.id}-${idx}`}
                      onClick={() => onPickItem(item)}
                      className={`text-left text-[10px] truncate rounded px-1 py-0.5 ${colors.soft} ${colors.border} border-l-2 ${
                        !isCurrentMonth ? "opacity-50" : ""
                      }`}
                    >
                      {item.name}
                    </button>
                  );
                })}
                {dayItems.length > 3 && (
                  <button
                    onClick={() => setDetailDay({ date, items: dayItems })}
                    className="text-[10px] text-blue-400 hover:text-blue-300 text-left px-1"
                  >
                    +{dayItems.length - 3} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {/* Day detail popover */}
      {detailDay && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          onClick={() => setDetailDay(null)}
        >
          <div
            className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold">
                {detailDay.date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </h3>
              <button onClick={() => setDetailDay(null)} className="p-1 rounded hover:bg-slate-800">
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>
            <div className="space-y-1.5 max-h-96 overflow-auto">
              {detailDay.items.map((item, idx) => {
                const colors = getPillarColor(item.pillar);
                return (
                  <button
                    key={`${item.id}-${idx}`}
                    onClick={() => {
                      onPickItem(item);
                      setDetailDay(null);
                    }}
                    className={`w-full text-left flex items-center gap-2 rounded-md px-2 py-1.5 ${colors.soft} ${colors.border} border-l-2`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${colors.dot} shrink-0`} />
                    <span className="text-xs font-medium truncate text-slate-100">{item.name}</span>
                    <span className="text-[10px] text-slate-400 ml-auto">
                      {formatTimeRange(item.start, item.end)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniMonthNavigator({
  weekStart,
  viewMode,
  onPick,
  onClose,
}: {
  weekStart: Date;
  viewMode: "week" | "month";
  onPick: (d: Date) => void;
  onClose: () => void;
}) {
  const [navDate, setNavDate] = useState(new Date(weekStart));
  const monthName = navDate.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const firstOfMonth = new Date(navDate.getFullYear(), navDate.getMonth(), 1);
  const gridStart = getWeekStart(firstOfMonth);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) days.push(addDays(gridStart, i));

  // Highlight the current view's range
  const rangeStart = viewMode === "month"
    ? getWeekStart(new Date(navDate.getFullYear(), navDate.getMonth(), 1))
    : weekStart;
  const rangeEnd = viewMode === "month"
    ? addDays(getWeekStart(new Date(navDate.getFullYear(), navDate.getMonth() + 1, 1)), 7)
    : addDays(weekStart, 7);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20" onClick={onClose}>
      <div className="w-72 bg-slate-900 border border-slate-700 rounded-2xl p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <button onClick={() => setNavDate(new Date(navDate.getFullYear(), navDate.getMonth() - 1, 1))} className="p-1 rounded hover:bg-slate-800">
            <ChevronLeft className="w-4 h-4 text-slate-400" />
          </button>
          <span className="text-sm font-medium">{monthName}</span>
          <button onClick={() => setNavDate(new Date(navDate.getFullYear(), navDate.getMonth() + 1, 1))} className="p-1 rounded hover:bg-slate-800">
            <ChevronRight className="w-4 h-4 text-slate-400" />
          </button>
        </div>
        <div className="grid grid-cols-7 gap-1 mb-1">
          {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
            <div key={i} className="text-center text-[10px] text-slate-500 font-medium">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {days.map((d, i) => {
            const isCurrentMonth = d.getMonth() === navDate.getMonth();
            const isToday = d.toDateString() === new Date().toDateString();
            const inRange = d >= rangeStart && d < rangeEnd;
            return (
              <button
                key={i}
                onClick={() => onPick(d)}
                className={`aspect-square flex items-center justify-center rounded-lg text-xs transition-colors ${
                  inRange ? "bg-blue-600/30 text-blue-200 font-semibold" :
                  isToday ? "bg-blue-600 text-white font-semibold" :
                  isCurrentMonth ? "text-slate-300 hover:bg-slate-800" :
                  "text-slate-600 hover:bg-slate-800"
                }`}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
