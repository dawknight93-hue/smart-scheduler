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
  ExternalLink,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { recheckEnrouteBlocks, type StoredEnrouteBlock } from "@/lib/calendarHygiene";
import {
  runEngine,
  getWeekStart,
  addDays,
  GRID_START_HOUR,
  GRID_END_HOUR,
  utaRanges,
  isUtaBlocked,
  utaBlockLabel,
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
import { getSyncStatus, pullFromGoogle, mirrorToGoogle, deleteFromGoogle, scheduleAutoPush, updateGoogleSourceEvent } from "@/lib/gcalSync";
import { parseRecurrenceFromItem, expandRecurrence, formatLocalDate, formatRecurrenceSummary } from "@/lib/recurrence";
import { mirrorCalendarNames, defaultMirrorWindowStart, MIRROR_WEEKS } from "@/lib/googleMirror";

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
const PX_PER_MIN = 64 / 60; // one hour row is h-16 (64px)

/** Minutes from the top of the day grid to this time. */
function minutesFromGridTop(d: Date): number {
  return (d.getHours() - GRID_START_HOUR) * 60 + d.getMinutes();
}
const NIGHT_START_HOUR = 21;
const NIGHT_END_HOUR = 9;

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

/** True if [start, end) touches a UTA day (same day boundaries the scheduler uses). */
function overlapsUta(start: Date, end: Date, fixedEvents: FixedEvent[]): boolean {
  return utaRanges(fixedEvents).some(([a, b]) => start < b && a < end);
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
        if (isUtaBlocked(itemToMove.pillar, itemToMove.context) && overlapsUta(slotStart, slotEnd, fixedEvents)) continue;
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

function formatWhen(d: Date): string {
  return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}, ${formatTime(d)}`;
}

function formatDuration(min: number): string {
  if (min < 60) return `${min}-min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}-hour`;
}

/** "45 min", "1 hr", "1 hr 30 min" */
function formatSpan(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

function unscheduledReasonText(u: UnscheduledItem): string {
  const window = `${formatWhen(u.windowStart)} – ${formatWhen(u.deadline)}`;
  switch (u.reason) {
    case "window_ended":
      return u.kind === "Task"
        ? `Its window ended ${formatWhen(u.deadline)} and it isn't marked done. Give it a new window or mark it complete.`
        : `Its window ended ${formatWhen(u.deadline)}. If it should happen every week, turn on Repeats.`;
    case "window_too_short":
      return `Its window (${window}) is shorter than the ${formatDuration(u.durationMin)} it needs.`;
    case "outside_hours":
      return `Its window (${window}) doesn't overlap scheduling hours (06:00–22:00) long enough for ${formatDuration(u.durationMin)}.`;
    case "family_uta":
      return `The only open time in its window is on a UTA day, and Family, Desk, Home and Errand items can't go on UTA days.`;
    case "no_free_time":
      return `No free ${formatDuration(u.durationMin)} block in its window (${window}) — that time is already booked.`;
  }
}

/** 24-hour clock, e.g. "07:05", "17:30". */
function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatTimeRange(start: Date, end: Date): string {
  return `${formatTime(start)}\u2013${formatTime(end)}`;
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

// Module-level so switching to Tasks/Goals and back (which remounts this view)
// doesn't trigger a fresh sync every time; opening the app always does.
let lastAutoSyncAt = 0;
let syncInFlight = false;
const AUTO_SYNC_MIN_GAP_MS = 2 * 60 * 1000;

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
  const [calendarConnections, setCalendarConnections] = useState<CalendarConnection[]>([]);
  const [googleConnected, setGoogleConnected] = useState(true);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [occurrences, setOccurrences] = useState<TaskOccurrence[]>([]);
  const [fixedEventOccurrences, setFixedEventOccurrences] = useState<FixedEventOccurrence[]>([]);
  const [habitOccurrences, setHabitOccurrences] = useState<HabitOccurrence[]>([]);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  // True when the edit modal was opened from the "not on your calendar" panel, which also offers Delete.
  const [editFromUnscheduled, setEditFromUnscheduled] = useState(false);
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
  const [viewMode, setViewMode] = useState<"day" | "week" | "month">("week");
  // Day view shows the single-day agenda (same layout as mobile) on desktop.
  const showDayView = layout === "mobile" || viewMode === "day";
  const [showMiniMonth, setShowMiniMonth] = useState(false);
  const [resizeState, setResizeState] = useState<{ item: PlacedItem; startY: number; originalEnd: Date; previewEnd: Date; hint?: string } | null>(null);

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

  // Sync with Google whenever the app is opened or brought back to the
  // foreground, so what's on screen (and in Google Calendar) is current.
  const syncRef = useRef<(opts?: { auto?: boolean }) => Promise<void>>(async () => {});
  syncRef.current = syncGoogle;
  useEffect(() => {
    const maybeSync = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastAutoSyncAt < AUTO_SYNC_MIN_GAP_MS) return;
      void syncRef.current({ auto: true });
    };
    maybeSync();
    document.addEventListener("visibilitychange", maybeSync);
    window.addEventListener("pageshow", maybeSync);
    return () => {
      document.removeEventListener("visibilitychange", maybeSync);
      window.removeEventListener("pageshow", maybeSync);
    };
  }, []);

  useEffect(() => {
    (async () => {
      const status = await getSyncStatus();
      const conns = (status?.connections ?? []) as CalendarConnection[];
      setCalendarConnections(conns);
      if (status) setGoogleConnected(!!status.connected);
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

  async function syncGoogle(opts: { auto?: boolean } = {}) {
    if (syncInFlight) return;
    syncInFlight = true;
    lastAutoSyncAt = Date.now();
    try {
      await runSync(opts);
    } finally {
      syncInFlight = false;
    }
  }

  async function runSync({ auto = false }: { auto?: boolean }) {
    setSyncing(true);
    if (!auto) setSyncMessage(null);
    const status = await getSyncStatus();
    if (!status?.connected) {
      // Opening the app shouldn't nag when Google isn't connected.
      if (!auto) setSyncMessage("Connect Google Calendar in settings first.");
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
    // Show what was just pulled from Google (and any Enroute changes) right away.
    await loadData();
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
      const removedIn = pullResult.eventsRemoved ? ` (${pullResult.eventsRemoved} removed that are no longer in Google)` : "";
      setSyncMessage(`Synced ${pullResult.eventsPulled ?? 0} events in${removedIn}. Google Calendar: ${changes}.${problems}`);
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
  // Current time for the "now" line; ticks every 30 s so the line and label stay current.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30 * 1000);
    return () => clearInterval(id);
  }, []);
  // Bring the now line into view once when the calendar first shows today.
  const scrolledToNow = useRef(false);
  const nowLineRef = (el: HTMLDivElement | null) => {
    if (!el || scrolledToNow.current || el.offsetParent === null) return;
    scrolledToNow.current = true;
    requestAnimationFrame(() => el.scrollIntoView({ block: "center" }));
  };
  // Where the dragged item would land if released now: which column (day index,
  // or -1 for the single-day view) and the snapped start time.
  const [dragPreview, setDragPreview] = useState<{ col: number; start: Date } | null>(null);
  // How far below the item's top edge it was grabbed, so it lands where it's drawn.
  const dragGrabOffset = useRef(0);

  function beginDrag(e: React.DragEvent, item: PlacedItem) {
    dragGrabOffset.current = e.clientY - e.currentTarget.getBoundingClientRect().top;
    setDragItem(item);
    e.dataTransfer.effectAllowed = "move";
  }

  function endDrag() {
    setDragItem(null);
    setDragPreview(null);
  }

  /** Snapped start time under the pointer for a drag over a day column. */
  function dropStartFromPointer(e: React.DragEvent, dayDate: Date): Date {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top - dragGrabOffset.current;
    const durationMin = dragItem ? Math.round((dragItem.end.getTime() - dragItem.start.getTime()) / 60000) : SLOT_MIN;
    let mins = Math.round(y / PX_PER_MIN / SLOT_MIN) * SLOT_MIN + GRID_START_HOUR * 60;
    mins = Math.max(GRID_START_HOUR * 60, Math.min(mins, GRID_END_HOUR * 60 - Math.max(SLOT_MIN, durationMin)));
    const start = new Date(dayDate);
    start.setHours(0, mins, 0, 0);
    return start;
  }

  function columnDragHandlers(col: number, dayDate: Date) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!dragItem) return;
        e.preventDefault();
        const start = dropStartFromPointer(e, dayDate);
        setDragPreview((prev) =>
          prev && prev.col === col && prev.start.getTime() === start.getTime() ? prev : { col, start }
        );
      },
      onDragLeave: (e: React.DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragPreview((prev) => (prev && prev.col === col ? null : prev));
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (!dragItem) return;
        const start = dropStartFromPointer(e, dayDate);
        setDragPreview(null);
        handleDrop(start);
      },
    };
  }

  /** Same rules the drop enforces, so the preview tells the truth before release. */
  function checkMove(item: PlacedItem, newStart: Date): { blocked?: string; overlaps: string[]; notes: string[] } {
    const newEnd = new Date(newStart.getTime() + (item.end.getTime() - item.start.getTime()));
    if (isQuietTime(newStart, newEnd)) return { blocked: "Can't schedule between 21:00 and 09:00", overlaps: [], notes: [] };
    if (isUtaBlocked(item.pillar, item.context) && overlapsUta(newStart, newEnd, fixedEvents)) {
      return { blocked: `${utaBlockLabel(item.pillar, item.context)} items can't go on UTA days`, overlaps: [], notes: [] };
    }
    if (placed.some((p) => p.kind === "Enroute" && rangesOverlap(newStart, newEnd, p.start, p.end))) {
      return { blocked: "Can't drop on an Enroute block", overlaps: [], notes: [] };
    }
    const notes: string[] = [];
    if (isRunnaEvent(item)) {
      // Runna only accepts calendar moves within the workout's own (Mon–Sun) plan week,
      // and swaps two workouts when one is moved onto the other's day.
      if (getWeekStart(newStart).getTime() !== getWeekStart(item.start).getTime()) {
        return { blocked: "Runna workouts can only move within their Mon–Sun week", overlaps: [], notes: [] };
      }
      if (newStart.toDateString() !== item.start.toDateString()) {
        // All-day events are stored at UTC midnight, so read their calendar day in UTC.
        const dayKey = (p: PlacedItem) =>
          p.isAllDay
            ? new Date(p.start.getUTCFullYear(), p.start.getUTCMonth(), p.start.getUTCDate()).toDateString()
            : p.start.toDateString();
        const sameDay = placed.find(
          (p) => p !== item && p.id !== item.id && isRunnaEvent(p) && dayKey(p) === newStart.toDateString()
        );
        if (sameDay) {
          const day = item.start.toLocaleDateString("en-US", { weekday: "short" });
          notes.push(`Runna will swap it with ${sameDay.name} (that run moves to ${day})`);
        }
      }
    }
    const overlaps = placed
      // All-day items sit in their own row and don't conflict with timed ones.
      .filter((p) => p.id !== item.id && p.kind !== "Enroute" && !p.isAllDay && rangesOverlap(newStart, newEnd, p.start, p.end))
      .map((p) => p.name);
    return { overlaps, notes };
  }

  function renderDragGhost(col: number) {
    if (!dragItem || !dragPreview || dragPreview.col !== col) return null;
    const start = dragPreview.start;
    const end = new Date(start.getTime() + (dragItem.end.getTime() - dragItem.start.getTime()));
    const { blocked, overlaps, notes } = checkMove(dragItem, start);
    const tone = blocked
      ? "border-rose-400 bg-rose-950/95"
      : overlaps.length || notes.length
      ? "border-amber-400 bg-amber-950/95"
      : "border-blue-400 bg-blue-950/95";
    const lines = blocked ? 1 : (overlaps.length ? 1 : 0) + notes.length;
    const height = Math.max(22 + lines * 16, ((end.getTime() - start.getTime()) / 60000) * PX_PER_MIN - 2);
    return (
      <div
        className={`absolute left-1 right-1 z-30 rounded-md border-2 border-dashed px-2 py-1 pointer-events-none shadow-lg ${tone}`}
        style={{ top: `${minutesFromGridTop(start) * PX_PER_MIN}px`, height: `${height}px` }}
      >
        <div className="text-[11px] font-semibold text-white leading-tight">{formatTimeRange(start, end)}</div>
        {blocked ? (
          <div className="text-[10px] text-rose-200 leading-tight mt-0.5">{blocked}</div>
        ) : (
          <>
            {overlaps.length > 0 && (
              <div className="text-[10px] text-amber-200 leading-tight mt-0.5 truncate">Overlaps {overlaps.join(", ")}</div>
            )}
            {notes.map((n) => (
              <div key={n} className="text-[10px] text-amber-200 leading-tight mt-0.5">{n}</div>
            ))}
          </>
        )}
      </div>
    );
  }

  /** Red "now" line with the current time, drawn in today's column only. */
  function renderNowLine(dayDate: Date) {
    if (dayDate.toDateString() !== now.toDateString()) return null;
    const top = minutesFromGridTop(now) * PX_PER_MIN;
    return (
      <div ref={nowLineRef} className="absolute left-0 right-0 z-20 pointer-events-none" style={{ top: `${top}px` }} aria-label={`Now, ${formatTime(now)}`}>
        <div className="relative h-0.5 bg-red-500 shadow-[0_0_4px_rgba(239,68,68,0.6)]">
          <span className="absolute -left-1.5 -top-[5px] w-3 h-3 rounded-full bg-red-500" />
          <span className="absolute left-2.5 -top-[9px] rounded bg-red-500 px-1.5 py-px text-[10px] font-semibold leading-4 text-white shadow">
            {formatTime(now)}
          </span>
        </div>
      </div>
    );
  }

  function renderResizeBadge(dayItems: PlacedItem[]) {
    if (!resizeState) return null;
    const it = dayItems.find(
      (i) => i.id === resizeState.item.id && i.start.getTime() === resizeState.item.start.getTime()
    );
    if (!it) return null;
    const mins = Math.round((resizeState.previewEnd.getTime() - it.start.getTime()) / 60000);
    const height = Math.max(20, mins * PX_PER_MIN - 2);
    return (
      <div
        className="absolute left-1 z-30 pointer-events-none rounded-md bg-slate-900 border border-slate-600 px-2 py-0.5 text-[11px] text-white shadow-lg whitespace-nowrap"
        style={{ top: `${minutesFromGridTop(it.start) * PX_PER_MIN + height + 4}px` }}
      >
        Ends {formatTime(resizeState.previewEnd)} · {formatSpan(mins)}
        {resizeState.hint && <span className="text-rose-300"> · {resizeState.hint}</span>}
      </div>
    );
  }
  const [dragMessage, setDragMessage] = useState<string | null>(null);
  const [overlapConfirm, setOverlapConfirm] = useState<{ item: PlacedItem; newStart: Date; overlapNames: string[] } | null>(null);
  // A resize that would leave a task/habit's window shorter than its duration asks first.
  const [resizeWarning, setResizeWarning] = useState<{
    item: PlacedItem;
    kind: "Task" | "Habit";
    newEnd: Date;
    windowMin: number;
    durationMin: number;
  } | null>(null);

  /** If resizing this task/habit to end at newEnd leaves too little window for its duration, describe it. */
  function resizeShortfall(item: PlacedItem, newEnd: Date) {
    if (item.isRecurringOccurrence || item.isBatch) return null;
    if (item.kind === "Task") {
      const t = tasks.find((x) => x.id === item.id);
      if (!t) return null;
      const windowMin = Math.round((newEnd.getTime() - new Date(t.search_start).getTime()) / 60000);
      return windowMin < t.duration_min ? { kind: "Task" as const, windowMin, durationMin: t.duration_min } : null;
    }
    if (item.kind === "Habit") {
      const h = habits.find((x) => x.id === item.id);
      if (!h) return null;
      const windowMin = Math.round((newEnd.getTime() - new Date(h.search_start).getTime()) / 60000);
      return windowMin < h.duration_min ? { kind: "Habit" as const, windowMin, durationMin: h.duration_min } : null;
    }
    return null;
  }

  async function resolveResizeWarning(choice: "shorten" | "edit" | "tray" | "cancel") {
    const w = resizeWarning;
    setResizeWarning(null);
    if (!w || choice === "cancel") return;
    const table = w.kind === "Task" ? "tasks" : "habits";
    const endCol = w.kind === "Task" ? "deadline" : "search_end";
    if (choice === "edit") {
      const src = w.kind === "Task" ? tasks.find((x) => x.id === w.item.id) : habits.find((x) => x.id === w.item.id);
      if (src) setEditTarget({ kind: w.kind, id: w.item.id, data: { ...src, [endCol]: w.newEnd.toISOString() } as Task | Habit });
      return;
    }
    if (choice === "shorten") {
      await supabase.from(table).update({ [endCol]: w.newEnd.toISOString(), duration_min: Math.max(SLOT_MIN, w.windowMin) }).eq("id", w.item.id);
    } else {
      await updateItemDuration(w.item, w.newEnd);
    }
    loadData();
    scheduleAutoPush();
  }
  const dragMessageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showDragMessage(msg: string, ms = 3000) {
    setDragMessage(msg);
    if (dragMessageTimer.current) clearTimeout(dragMessageTimer.current);
    dragMessageTimer.current = setTimeout(() => setDragMessage(null), ms);
  }

  /** Events pulled from one of your Google calendars (not ones the app itself writes). */
  function isFromGoogle(item: PlacedItem): boolean {
    return item.kind === "Fixed Event" && !!item.googleEventId && !!item.googleCalendarId && item.googleCalendarRole !== "schedule_target";
  }

  function isRunnaEvent(item: PlacedItem): boolean {
    if (!isFromGoogle(item)) return false;
    return calendarConnections.some((c) => c.calendar_id === item.googleCalendarId && /runna/i.test(c.name));
  }

  /**
   * Save a move/resize of a Google-sourced event to its own Google calendar first,
   * so the next sync doesn't put it back. Returns false (and says why) if Google refused.
   */
  async function writeBackToGoogle(item: PlacedItem, newStart: Date, newEnd: Date): Promise<boolean> {
    if (!isFromGoogle(item)) return true;
    const res = await updateGoogleSourceEvent(item.googleEventId!, item.googleCalendarId!, newStart, newEnd);
    if (!res.success) {
      showDragMessage(`Not moved — couldn't save it to Google Calendar: ${res.error ?? "unknown error"}`, 7000);
      return false;
    }
    return true;
  }

  async function updateItemTime(item: PlacedItem, newStart: Date): Promise<boolean> {
    const durationMs = item.end.getTime() - item.start.getTime();
    const newEnd = new Date(newStart.getTime() + durationMs);
    if (!(await writeBackToGoogle(item, newStart, newEnd))) return false;
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
      return true;
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
    return true;
  }

  async function updateItemDuration(item: PlacedItem, newEnd: Date): Promise<boolean> {
    if (!(await writeBackToGoogle(item, item.start, newEnd))) return false;
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
      return true;
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
    return true;
  }

  function handleResizeStart(e: React.MouseEvent, item: PlacedItem) {
    e.stopPropagation();
    e.preventDefault();
    setResizeState({ item, startY: e.clientY, originalEnd: item.end, previewEnd: item.end });
  }

  useEffect(() => {
    if (!resizeState) return;
    const onMove = (e: MouseEvent) => {
      // Pointer movement in pixels → minutes on the grid (64px per hour).
      // Move the end in whole 15-minute steps from where it started, so a tiny
      // wiggle (or dragging back) leaves the original end time untouched.
      const deltaMin = Math.round((e.clientY - resizeState.startY) / PX_PER_MIN / SLOT_MIN) * SLOT_MIN;
      const snapped = new Date(resizeState.originalEnd.getTime() + deltaMin * 60 * 1000);
      const minEnd = new Date(resizeState.item.start.getTime() + 15 * 60 * 1000);
      const hint = (h: string) => setResizeState((prev) => (prev && prev.hint !== h ? { ...prev, hint: h } : prev));
      if (snapped < minEnd) return hint("15 min minimum");
      if (isQuietTime(resizeState.item.start, snapped)) return hint("can't run into 21:00–09:00");
      if (isUtaBlocked(resizeState.item.pillar, resizeState.item.context) && overlapsUta(resizeState.item.start, snapped, fixedEvents)) return hint(`${utaBlockLabel(resizeState.item.pillar, resizeState.item.context)} items can't go on UTA days`);
      setResizeState((prev) => (prev ? { ...prev, previewEnd: snapped, hint: undefined } : null));
    };
    const onUp = async () => {
      const rs = resizeState;
      if (rs && rs.previewEnd.getTime() !== rs.originalEnd.getTime()) {
        const short = resizeShortfall(rs.item, rs.previewEnd);
        if (short) {
          setResizeWarning({ item: rs.item, newEnd: rs.previewEnd, ...short });
          setResizeState(null);
          return;
        }
        await updateItemDuration(rs.item, rs.previewEnd);
        // Reload either way: on success to show the change, on failure to snap back.
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
    endDrag();
    if (!item) return;

    const newStart = snapToSlot(targetDate);

    if (newStart.getTime() === item.start.getTime() && newStart.getDate() === item.start.getDate()) {
      return;
    }

    const check = checkMove(item, newStart);
    if (check.blocked) {
      showDragMessage(check.blocked);
      return;
    }

    if (check.overlaps.length > 0) {
      setOverlapConfirm({
        item,
        newStart,
        overlapNames: check.overlaps,
      });
      return;
    }

    const saved = await updateItemTime(item, newStart);
    if (!saved) return;
    if (check.notes.length) showDragMessage(`Saved to Google Calendar. ${check.notes.join(". ")} on the next sync.`, 6000);
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
      !p.isAllDay &&
      rangesOverlap(newStart, new Date(newStart.getTime() + durationMin * 60000), p.start, p.end)
    );

    if (!(await updateItemTime(item, newStart))) return;

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
  // Completed tasks don't need a slot, so they're never "unscheduled".
  const notScheduled = unscheduled.filter(
    (u) => !(u.kind === "Task" && !u.isBatch && tasks.find((t) => t.id === u.id)?.completed_at)
  );
  const stats = {
    fixed: placed.filter((p) => p.kind === "Fixed Event").length,
    habits: placed.filter((p) => p.kind === "Habit").length,
    tasks: placed.filter((p) => p.kind === "Task").length,
    unscheduled: notScheduled.length,
  };

  function editUnscheduled(u: UnscheduledItem) {
    if (u.isBatch) return;
    const data = u.kind === "Habit" ? habits.find((h) => h.id === u.id) : tasks.find((t) => t.id === u.id);
    if (data) {
      setEditTarget({ kind: u.kind as "Habit" | "Task", id: u.id, data });
      setEditFromUnscheduled(true);
    }
  }

  async function deleteUnscheduled(target: EditTarget) {
    const table = target.kind === "Habit" ? "habits" : "tasks";
    const { error } = await supabase.from(table).delete().eq("id", target.id);
    if (error) throw new Error(error.message);
    await loadData();
    // The Google mirror drops any copies of this item on its next run.
    scheduleAutoPush();
  }

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
          <div className={!showDayView ? "flex items-center gap-1 shrink-0" : "hidden"}>
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

          {/* Day navigation (mobile, and desktop Day view) */}
          <div className={showDayView ? "flex items-center gap-1 shrink-0" : "hidden"}>
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
                if (layout === "desktop") setViewMode("day");
              }}
              className="px-2.5 py-1.5 text-xs rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors"
              title="Show today's agenda"
            >
              Today
            </button>
            {/* Week/Month view toggle (desktop only) */}
            {layout === "desktop" && (
              <div className="flex items-center rounded-lg bg-slate-800 overflow-hidden">
                <button
                  onClick={() => setViewMode("day")}
                  className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    viewMode === "day" ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  Day
                </button>
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
                  viewMode={showDayView ? "day" : viewMode}
                  selectedDay={mobileDate}
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
          <div className={!showDayView ? "inline-flex flex-col min-w-full" : "hidden"}>
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
                    {`${String(h).padStart(2, "0")}:00`}
                  </div>
                ))}
              </div>

              {/* Day columns */}
              {DAYS.map((_, dayIdx) => (
                <div
                  key={dayIdx}
                  className="flex-1 min-w-[140px] border-r border-slate-800 last:border-r-0 relative"
                  {...columnDragHandlers(dayIdx, addDays(weekStart, dayIdx))}
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
                        onDragStart={(e) => { if (!isEnroute) beginDrag(e, item); }}
                        onDragEnd={endDrag}
                        className={`absolute left-1 right-1 rounded-md ${colors.soft} ${colors.border} border-l-2 px-2 py-1 text-left overflow-hidden group ${isEnroute ? "border-dashed" : "hover:z-10 hover:scale-[1.02] transition-transform cursor-pointer"} ${isDisplayOnly ? "opacity-60 border-dashed" : ""} ${dragItem && dragItem.id === item.id && dragItem.start.getTime() === item.start.getTime() ? "opacity-40" : ""}`}
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
                  {renderNowLine(addDays(weekStart, dayIdx))}
                  {renderDragGhost(dayIdx)}
                  {renderResizeBadge(itemsByDay[dayIdx])}
                </div>
              ))}
            </div>
              </>
            )}
          </div>
        )}
          {/* Single-day view (mobile, and desktop Day view) */}
          <div className={showDayView ? "flex flex-col" : "hidden"}>
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
                    {`${String(h).padStart(2, "0")}:00`}
                  </div>
                ))}
              </div>
              <div className="flex-1 relative" {...columnDragHandlers(-1, mobileDate)}>
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
                      onDragStart={(e) => beginDrag(e, item)}
                      onDragEnd={endDrag}
                      className={`absolute left-1 right-1 rounded-md ${colors.soft} ${colors.border} border-l-2 overflow-hidden ${isDisplayOnly ? "opacity-60 border-dashed" : ""} ${dragItem && dragItem.id === item.id && dragItem.start.getTime() === item.start.getTime() ? "opacity-40" : ""}`}
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
                {renderNowLine(mobileDate)}
                {renderDragGhost(-1)}
                {renderResizeBadge(itemsByDay[mobileDayIndex])}
              </div>
            </div>
          </div>
      </div>

      {/* Items the engine couldn't put on the calendar this week, with why */}
      {notScheduled.length > 0 && (
        <div className="border-t border-slate-800 bg-slate-900/50 px-6 py-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-medium text-amber-400">
              {notScheduled.length} item{notScheduled.length > 1 ? "s" : ""} not on your calendar this week
            </span>
          </div>
          <p className="mt-1 mb-2 text-xs text-slate-400">
            These don't appear here or in Google Calendar. Tap one to change its time window or duration, or to delete it.
          </p>
          <div className="flex flex-col gap-2">
            {notScheduled.map((u) => {
              const overdue = u.reason === "window_ended" && u.kind === "Task";
              return (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => editUnscheduled(u)}
                  disabled={u.isBatch}
                  className={`text-left px-3 py-2 rounded-lg border text-xs ${
                    overdue
                      ? "bg-red-500/10 border-red-500/30 text-red-300 hover:bg-red-500/15"
                      : "bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/15"
                  } disabled:cursor-default`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{u.name}</span>
                    <span className="opacity-70">
                      {u.kind} · {TIER_LABELS[u.tier]}
                    </span>
                    {overdue && <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase">Overdue</span>}
                  </div>
                  <div className="mt-0.5 text-slate-300/80">{unscheduledReasonText(u)}</div>
                </button>
              );
            })}
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
          source={describeItemSource(selectedItem, calendarConnections, googleConnected)}
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
          onClose={() => { setEditTarget(null); setEditFromUnscheduled(false); }}
          onSaved={loadData}
          editTarget={editTarget}
          onDelete={editFromUnscheduled ? () => deleteUnscheduled(editTarget) : undefined}
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
      {resizeWarning && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
          onClick={() => resolveResizeWarning("cancel")}
        >
          <div
            className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
              <h3 className="text-base font-semibold">It won't fit anymore</h3>
            </div>
            <p className="text-sm text-slate-300 mb-2">
              Resizing <span className="font-medium text-white">{resizeWarning.item.name}</span> sets its{" "}
              {resizeWarning.kind === "Task" ? "deadline" : "search end"} to {formatTime(resizeWarning.newEnd)}, leaving{" "}
              {Math.max(0, resizeWarning.windowMin)} min in its window — but it needs {resizeWarning.durationMin} min.
            </p>
            <p className="text-xs text-slate-500 mb-4">
              If you keep it this way it comes off the calendar and goes to the "not on your calendar" tray.
            </p>
            <div className="flex flex-col gap-2">
              {resizeWarning.windowMin >= SLOT_MIN && (
                <button
                  onClick={() => resolveResizeWarning("shorten")}
                  className="w-full py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 transition-colors"
                >
                  Change duration to {resizeWarning.windowMin} min
                </button>
              )}
              <button
                onClick={() => resolveResizeWarning("edit")}
                className="w-full py-2.5 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-300 text-sm font-medium hover:bg-blue-500/20 transition-colors"
              >
                Edit {resizeWarning.kind === "Task" ? "task" : "habit"}…
              </button>
              <button
                onClick={() => resolveResizeWarning("tray")}
                className="w-full py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm font-medium hover:bg-amber-500/20 transition-colors"
              >
                Send to tray
              </button>
              <button
                onClick={() => resolveResizeWarning("cancel")}
                className="w-full py-2.5 rounded-lg bg-slate-800 text-slate-300 text-sm font-medium hover:bg-slate-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

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

/** Where an item on the calendar comes from, for the detail popup's "Calendar" box. */
interface ItemSource {
  title: string;
  detail: string;
  fromGoogle: boolean;
  googleUrl?: string;
}

/** Google Calendar web link for one event (the "eid" is base64 of "<eventId> <calendarId>"). */
function googleEventUrl(eventId: string, calendarId: string): string | undefined {
  try {
    // Same encoding Google uses for an event's htmlLink (group/gmail suffixes shortened).
    const cal = calendarId.replace(/@group\.calendar\.google\.com$/, "@g").replace(/@gmail\.com$/, "@m");
    const eid = btoa(`${eventId} ${cal}`).replace(/=+$/, "");
    return `https://www.google.com/calendar/event?eid=${eid}`;
  } catch {
    return undefined;
  }
}

function describeItemSource(item: PlacedItem, connections: CalendarConnection[], googleConnected: boolean): ItemSource {
  // Pulled from Google: the event map records which calendar it came from.
  if (item.googleEventId && item.googleCalendarId && item.googleCalendarRole !== "schedule_target") {
    const conn = connections.find((c) => c.calendar_id === item.googleCalendarId && c.role !== "schedule_target")
      ?? connections.find((c) => c.calendar_id === item.googleCalendarId);
    const blocks = item.googleCalendarRole !== "display_only";
    return {
      title: conn?.name ?? "Google Calendar",
      detail: `Pulled from Google Calendar · ${blocks ? "blocks your schedule" : "display only, doesn't block scheduling"}`,
      fromGoogle: true,
      googleUrl: googleEventUrl(item.googleEventId, item.googleCalendarId),
    };
  }

  const origin = item.kind === "Enroute" ? "Added automatically from your flights" : "Created in Smart Scheduler";
  if (!googleConnected) {
    return { title: "Smart Scheduler", detail: `${origin} · not in Google (Google Calendar isn't connected)`, fromGoogle: false };
  }
  const names = mirrorCalendarNames(connections);
  if (!names) {
    return {
      title: "Smart Scheduler",
      detail: connections.length === 0 ? origin : `${origin} · not sent to Google (no Write target calendar is set)`,
      fromGoogle: false,
    };
  }
  const kind = item.recurringItemKind ?? item.kind;
  const target = kind === "Fixed Event" ? names.personal : kind === "Habit" ? names.habits : names.tasks;
  // One-off habits/tasks and Enroute blocks are mirrored over a rolling window;
  // repeating items go to Google as a whole series, and Fixed Events always go.
  const windowEnd = new Date(defaultMirrorWindowStart().getTime() + (MIRROR_WEEKS * 7 + 1) * 24 * 60 * 60 * 1000);
  const rolling = !item.isRecurringOccurrence && kind !== "Fixed Event";
  const later = rolling && item.start >= windowEnd;
  return {
    title: "Smart Scheduler",
    detail: later
      ? `${origin} · goes to Google Calendar ("${target}") once it's within ${MIRROR_WEEKS} weeks`
      : `${origin} · shown in Google Calendar on "${target}"`,
    fromGoogle: false,
  };
}

function ItemDetail({
  item,
  source,
  onClose,
  onDelete,
  onEdit,
  onSetPillar,
}: {
  item: PlacedItem;
  source: ItemSource;
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
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-800/40 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Calendar</span>
            {source.googleUrl && (
              <a
                href={source.googleUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
              >
                Open in Google
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 min-w-0">
            <CalendarDays className={`w-4 h-4 shrink-0 ${source.fromGoogle ? "text-blue-400" : "text-emerald-400"}`} />
            <span className="text-sm font-medium text-slate-100 truncate">{source.title}</span>
          </div>
          <div className="mt-0.5 pl-6 text-xs text-slate-400">{source.detail}</div>
        </div>
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
  selectedDay,
  onPick,
  onClose,
}: {
  weekStart: Date;
  viewMode: "day" | "week" | "month";
  selectedDay: Date;
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
    : viewMode === "day"
    ? selectedDay
    : weekStart;
  const rangeEnd = viewMode === "month"
    ? addDays(getWeekStart(new Date(navDate.getFullYear(), navDate.getMonth() + 1, 1)), 7)
    : addDays(rangeStart, viewMode === "day" ? 1 : 7);

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
