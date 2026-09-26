import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Grid3x3,
  Inbox,
  List,
  Lock,
  Menu,
  Monitor,
  Plane,
  Plus,
  RefreshCw,
  Settings,
  Square,
  Sunrise,
  CheckCircle2,
  X,
  Layers,
} from "lucide-react";
import type { LifePillar, PlacedItem } from "@/lib/types";
import { PILLARS, PILLAR_LABELS, getPillarColor } from "@/lib/types";
import { addDays, getWeekStart, GRID_START_HOUR, GRID_END_HOUR } from "@/lib/schedulingEngine";
import { layoutColumns, type ItemLayout } from "@/lib/calendarLayout";

/**
 * The phone calendar, laid out like Google Calendar's app: a menu drawer for
 * views and filters, a big month title, full-width colour cards, a + button,
 * and details in a bottom sheet (ItemDetail). The data and every action stay in
 * CalendarView; this only draws them.
 */

export type MobileView = "schedule" | "day" | "3day" | "week" | "month";
export const MOBILE_VIEWS: MobileView[] = ["schedule", "day", "3day", "week", "month"];
const VIEW_KEY = "smartScheduler.mobileView";
const HIDDEN_KEY = "smartScheduler.hiddenPillars";

export function loadMobileView(): MobileView {
  try {
    const v = window.localStorage.getItem(VIEW_KEY) as MobileView | null;
    return v && MOBILE_VIEWS.includes(v) ? v : "schedule";
  } catch {
    return "schedule";
  }
}

export function saveMobileView(v: MobileView) {
  try {
    window.localStorage.setItem(VIEW_KEY, v);
  } catch {
    // private browsing etc.
  }
}

const DOW = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const DAY_MS = 86400000;
const dayIdx = (d: Date) => (d.getDay() + 6) % 7;
/**
 * 3 Day stays inside one Mon–Sun week, because the scheduler places habits and
 * tasks a week at a time: Sat or Sun shows Fri–Sun.
 */
const threeDayStart = (anchor: Date) => addDays(getWeekStart(anchor), Math.min(dayIdx(anchor), 4));

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Does this item show on this calendar day? (All-day items span their days.) */
function onDay(p: PlacedItem, day: Date): boolean {
  const s = startOfDay(day).getTime();
  const e = s + DAY_MS;
  if (p.isAllDay) {
    // All-day ends are exclusive midnights.
    return p.start.getTime() < e && p.end.getTime() > s;
  }
  return p.start.getTime() >= s && p.start.getTime() < e;
}

function cardClasses(p: PlacedItem) {
  const c = getPillarColor(p.pillar);
  const muted = p.kind === "Fixed Event" && p.blocksSchedule === false;
  const enroute = p.kind === "Enroute";
  if (enroute) return { box: "border border-dashed border-slate-600 bg-slate-800/60 text-slate-300", sub: "text-slate-400" };
  return {
    box: `${c.bg} ${c.text} ${muted ? "opacity-60" : ""} ${p.completed ? "opacity-50" : ""}`,
    sub: "opacity-85",
  };
}

function layoutStyle(l: ItemLayout | undefined): React.CSSProperties {
  if (!l || l.cols === 1) return { left: "2px", right: "2px" };
  const w = 100 / l.cols;
  return { left: `calc(${l.col * w}% + 1px)`, width: `calc(${l.span * w}% - 2px)` };
}

interface Props {
  placed: PlacedItem[];
  loading: boolean;
  weekStart: Date;
  setWeekStart: (d: Date) => void;
  setDayIndex: (i: number) => void;
  dayIndex: number;
  view: MobileView;
  setView: (v: MobileView) => void;
  monthGridStart: Date;
  now: Date;
  notScheduledCount: number;
  renderTray: () => ReactNode;
  onSelect: (item: PlacedItem) => void;
  onAddAt: (date: Date | null) => void;
  syncing: boolean;
  syncLabel: string;
  syncMessage: string | null;
  onSync: () => void;
  recheckingFlights: boolean;
  onRecheckFlights: () => void;
  onOpenConnections: () => void;
  onSwitchDesktop: () => void;
  onOpenBriefing?: () => void;
  miniMonth: (selected: Date, onPick: (d: Date) => void, onClose: () => void) => ReactNode;
}

export function MobileCalendar(props: Props) {
  const { placed, weekStart, view, setView, now } = props;
  const [drawer, setDrawer] = useState(false);
  const [tray, setTray] = useState(false);
  const [showMini, setShowMini] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(window.localStorage.getItem(HIDDEN_KEY) || "[]"));
    } catch {
      return new Set();
    }
  });
  // The day everything is centred on. In Month the parent's weekStart is the 1st.
  const [anchor, setAnchor] = useState<Date>(() => (view === "month" ? startOfDay(new Date()) : addDays(weekStart, props.dayIndex)));

  // Line the parent's week (or month) up with the anchor for the view we open in.
  useEffect(() => {
    goTo(anchor, view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => placed.filter((p) => !hidden.has(p.pillar ?? "none")), [placed, hidden]);

  function toggleHidden(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  }

  /** Move to a date (and optionally a view), keeping the parent's week/month in step. */
  function goTo(date: Date, v: MobileView = view) {
    const d = startOfDay(date);
    if (v === "month") props.setWeekStart(new Date(d.getFullYear(), d.getMonth(), 1));
    else props.setWeekStart(getWeekStart(d));
    props.setDayIndex((d.getDay() + 6) % 7);
    setAnchor(d);
    if (v !== view) {
      setView(v);
      saveMobileView(v);
    }
  }

  function step(dir: 1 | -1) {
    if (view === "month") goTo(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
    else if (view === "day") goTo(addDays(anchor, dir));
    else if (view === "3day") {
      const start = dayIdx(threeDayStart(anchor));
      const ws = getWeekStart(anchor);
      if (dir === 1) goTo(start >= 4 ? addDays(ws, 7) : addDays(ws, Math.min(start + 3, 4)));
      else goTo(start === 0 ? addDays(ws, -3) : addDays(ws, Math.max(start - 3, 0)));
    }
    else goTo(addDays(anchor, dir * 7));
  }

  const title =
    anchor.toLocaleDateString("en-US", { month: "long" }) +
    (anchor.getFullYear() !== new Date().getFullYear() ? ` ${anchor.getFullYear()}` : "");

  const todayNum = new Date().getDate();

  return (
    <div className="relative flex-1 min-h-0 flex flex-col bg-slate-950">
      {/* Top bar */}
      <header className="shrink-0 flex items-center gap-0.5 px-1.5 h-14">
        <button onClick={() => setDrawer(true)} className="w-11 h-11 flex items-center justify-center rounded-full text-slate-300 active:bg-slate-800" aria-label="Open menu">
          <Menu className="w-6 h-6" />
        </button>
        <div className="relative">
          <button
            onClick={() => setShowMini((s) => !s)}
            className="flex items-center gap-1 h-11 px-1.5 text-[22px] font-semibold text-slate-50 tracking-tight"
            aria-label="Pick a date"
          >
            {title}
            <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showMini ? "rotate-180" : ""}`} />
          </button>
          {showMini &&
            props.miniMonth(
              anchor,
              (d) => {
                setShowMini(false);
                goTo(d, view === "month" ? "day" : view);
              },
              () => setShowMini(false),
            )}
        </div>
        <div className="flex-1" />
        {props.syncing && <RefreshCw className="w-4 h-4 text-slate-500 animate-spin mr-1" aria-label="Syncing" />}
        <button onClick={() => step(-1)} className="w-10 h-11 flex items-center justify-center text-slate-400 active:bg-slate-800 rounded-full" aria-label="Previous">
          <ChevronLeft className="w-5 h-5" />
        </button>
        <button onClick={() => step(1)} className="w-10 h-11 flex items-center justify-center text-slate-400 active:bg-slate-800 rounded-full" aria-label="Next">
          <ChevronRight className="w-5 h-5" />
        </button>
        <button onClick={() => goTo(new Date())} className="w-11 h-11 flex items-center justify-center text-slate-300 active:bg-slate-800 rounded-full" aria-label="Jump to today">
          <span className="w-6 h-6 rounded-md border-2 border-current flex items-center justify-center text-[11px] font-bold">{todayNum}</span>
        </button>
      </header>
      {props.syncMessage && <p className="shrink-0 px-4 pb-1 text-[11px] text-blue-300 line-clamp-2">{props.syncMessage}</p>}

      {props.loading && !placed.length ? (
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm animate-pulse">Loading schedule…</div>
      ) : view === "schedule" ? (
        <ScheduleList items={visible} weekStart={getWeekStart(anchor)} anchor={anchor} now={now} onSelect={props.onSelect} onOpenBriefing={props.onOpenBriefing} onStepWeek={(d) => goTo(addDays(getWeekStart(anchor), d * 7))} onPickDay={(d) => goTo(d, "day")} />
      ) : view === "month" ? (
        <MonthGrid items={visible} anchor={anchor} gridStart={props.monthGridStart} onPickDay={(d) => goTo(d, "day")} onPickMonth={(d) => goTo(d, "month")} />
      ) : (
        <TimeGrid
          view={view}
          items={visible}
          anchor={anchor}
          now={now}
          onSelect={props.onSelect}
          onPickDay={(d) => goTo(d)}
          onAddAt={props.onAddAt}
        />
      )}

      {/* Not on the calendar */}
      {props.notScheduledCount > 0 && (
        <button
          onClick={() => setTray(true)}
          className="absolute left-4 bottom-4 z-20 h-11 px-4 rounded-full bg-slate-800 border border-slate-700 text-slate-100 text-sm font-semibold flex items-center gap-2 shadow-lg shadow-black/40"
        >
          <Inbox className="w-4 h-4 text-amber-400" />
          {props.notScheduledCount} not on calendar
        </button>
      )}

      {/* Add */}
      <button
        onClick={() => props.onAddAt(view === "schedule" || sameDay(anchor, new Date()) ? null : new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 9))}
        className="absolute right-4 bottom-4 z-20 w-14 h-14 rounded-2xl bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-600/40 active:bg-blue-500"
        aria-label="Add item"
      >
        <Plus className="w-7 h-7" />
      </button>

      {/* Drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50" role="dialog" aria-label="Calendar menu">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDrawer(false)} />
          <nav
            className="absolute left-0 top-0 bottom-0 w-[80%] max-w-[320px] bg-slate-900 rounded-r-2xl shadow-2xl flex flex-col overflow-y-auto px-3"
            style={{ paddingTop: "calc(env(safe-area-inset-top) + 16px)", paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)" }}
          >
            <div className="px-3 pb-3">
              <p className="text-xl font-bold tracking-tight text-slate-50">Smart Scheduler</p>
              <p className="text-xs text-slate-400">Priority-aware calendar</p>
            </div>
            {(
              [
                ["schedule", "Schedule", List],
                ["day", "Day", Square],
                ["3day", "3 Day", Columns3],
                ["week", "Week", CalendarDays],
                ["month", "Month", Grid3x3],
              ] as [MobileView, string, typeof List][]
            ).map(([v, label, Icon]) => (
              <button
                key={v}
                onClick={() => {
                  setDrawer(false);
                  goTo(anchor, v);
                }}
                aria-current={view === v ? "page" : undefined}
                className={`flex items-center gap-3.5 h-12 px-3.5 rounded-full text-[15px] ${view === v ? "bg-blue-600/25 text-blue-100 font-semibold" : "text-slate-300 active:bg-slate-800"}`}
              >
                <Icon className="w-5 h-5" />
                {label}
              </button>
            ))}
            <div className="h-px bg-slate-800 my-2 mx-2" />
            <button
              onClick={() => {
                setDrawer(false);
                setTray(true);
              }}
              className="flex items-center gap-3.5 h-12 px-3.5 rounded-full text-[15px] text-slate-300 active:bg-slate-800"
            >
              <Inbox className="w-5 h-5 text-amber-400" />
              <span className="flex-1 text-left">Not on calendar</span>
              {props.notScheduledCount > 0 && (
                <span className="min-w-[22px] h-[22px] px-1.5 rounded-full bg-amber-500/15 text-amber-300 text-xs font-bold flex items-center justify-center">{props.notScheduledCount}</span>
              )}
            </button>
            <div className="h-px bg-slate-800 my-2 mx-2" />
            <p className="px-3.5 pt-1 pb-1.5 text-[11px] font-bold tracking-[0.08em] text-slate-500">LIFE ROLES</p>
            {[...PILLARS, "none" as const].map((p) => {
              const key = p;
              const c = getPillarColor(p === "none" ? null : (p as LifePillar));
              const on = !hidden.has(key);
              return (
                <label key={key} className="flex items-center gap-3.5 h-10 px-3.5 text-[14.5px] text-slate-300">
                  <input type="checkbox" checked={on} onChange={() => toggleHidden(key)} className="w-[18px] h-[18px] accent-blue-500" />
                  <span className="flex-1">{p === "none" ? "No role set" : PILLAR_LABELS[p as LifePillar]}</span>
                  <span className={`w-2.5 h-2.5 rounded-sm ${c.bg}`} />
                </label>
              );
            })}
            <div className="flex-1 min-h-4" />
            <div className="h-px bg-slate-800 my-2 mx-2" />
            <button onClick={() => props.onSync()} disabled={props.syncing} className="flex items-center gap-3.5 h-11 px-3.5 rounded-full text-[15px] text-slate-300 active:bg-slate-800 disabled:opacity-60">
              <RefreshCw className={`w-5 h-5 ${props.syncing ? "animate-spin" : ""}`} />
              <span className="flex-1 text-left">Sync Google Calendar</span>
              <span className="text-[11px] text-slate-500">{props.syncLabel}</span>
            </button>
            <button onClick={() => props.onRecheckFlights()} disabled={props.recheckingFlights} className="flex items-center gap-3.5 h-11 px-3.5 rounded-full text-[15px] text-slate-300 active:bg-slate-800 disabled:opacity-60">
              <Plane className={`w-5 h-5 ${props.recheckingFlights ? "animate-pulse" : ""}`} />
              Recheck flights
            </button>
            <button
              onClick={() => {
                setDrawer(false);
                props.onOpenConnections();
              }}
              className="flex items-center gap-3.5 h-11 px-3.5 rounded-full text-[15px] text-slate-300 active:bg-slate-800"
            >
              <Settings className="w-5 h-5" />
              Calendar connections
            </button>
            <button
              onClick={() => {
                setDrawer(false);
                props.onSwitchDesktop();
              }}
              className="flex items-center gap-3.5 h-11 px-3.5 rounded-full text-[15px] text-slate-300 active:bg-slate-800"
            >
              <Monitor className="w-5 h-5" />
              Use desktop layout
            </button>
          </nav>
        </div>
      )}

      {/* Tray sheet */}
      {tray && (
        <div className="fixed inset-0 z-50 flex items-end" role="dialog" aria-label="Not on your calendar">
          <div className="absolute inset-0 bg-black/60" onClick={() => setTray(false)} />
          <div
            className="relative w-full max-h-[80dvh] overflow-y-auto rounded-t-2xl bg-slate-900 border-t border-slate-700 px-4 pt-2"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)" }}
          >
            <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-slate-700" />
            <div className="flex justify-end -mb-6">
              <button onClick={() => setTray(false)} className="p-1.5 rounded-full bg-slate-800 text-slate-400" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            {props.notScheduledCount > 0 ? props.renderTray() : <p className="py-6 text-sm text-slate-400">Everything is on your calendar this week.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Schedule */

function ScheduleCard({ p, onSelect }: { p: PlacedItem; onSelect: (p: PlacedItem) => void }) {
  const k = cardClasses(p);
  const enroute = p.kind === "Enroute";
  return (
    <button
      onClick={enroute ? undefined : () => onSelect(p)}
      className={`w-full text-left rounded-[10px] px-3 py-2 flex flex-col gap-0.5 ${k.box} ${enroute ? "cursor-default" : "active:brightness-110"}`}
    >
      <span className={`flex items-center gap-1.5 text-[15px] font-semibold leading-snug ${p.completed ? "line-through" : ""}`}>
        {p.completed && <CheckCircle2 className="w-4 h-4 shrink-0" aria-label="Completed" />}
        <span className="min-w-0 break-words">{p.name}</span>
        {p.readOnly && <Lock className="w-3 h-3 shrink-0 opacity-70" aria-label="Locked" />}
        {p.isBatch && <Layers className="w-3 h-3 shrink-0 opacity-70" aria-label="Batched" />}
      </span>
      <span className={`text-[13px] ${k.sub}`}>
        {hhmm(p.start)}–{hhmm(p.end)}
        {p.recurrenceSummary ? ` · ${p.recurrenceSummary}` : ""}
      </span>
    </button>
  );
}

function AllDayChip({ p, onSelect, small }: { p: PlacedItem; onSelect: (p: PlacedItem) => void; small?: boolean }) {
  const c = getPillarColor(p.pillar);
  return (
    <button
      onClick={() => onSelect(p)}
      className={`w-full text-left truncate ${small ? "rounded-[5px] px-1.5 py-0.5 text-[11px]" : "rounded-lg px-3 py-1.5 text-[13.5px]"} font-semibold ${c.bg} ${c.text} ${p.blocksSchedule === false ? "opacity-70" : ""}`}
    >
      {p.name}
    </button>
  );
}

function ScheduleList({
  items,
  weekStart,
  anchor,
  now,
  onSelect,
  onOpenBriefing,
  onStepWeek,
  onPickDay,
}: {
  items: PlacedItem[];
  weekStart: Date;
  anchor: Date;
  now: Date;
  onSelect: (p: PlacedItem) => void;
  onOpenBriefing?: () => void;
  onStepWeek: (dir: 1 | -1) => void;
  onPickDay: (d: Date) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = startOfDay(now);

  // Bring the chosen day to the top.
  useEffect(() => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-day="${startOfDay(anchor).getTime()}"]`);
    if (el && scrollRef.current) scrollRef.current.scrollTop = el.offsetTop - 8;
  }, [anchor, weekStart]);

  const todaysAllDay = items.filter((p) => p.isAllDay && onDay(p, today));

  return (
    <div ref={scrollRef} className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 pb-24">
      <button onClick={() => onStepWeek(-1)} className="w-full py-2 text-xs font-semibold text-blue-300">
        ‹ Previous week
      </button>
      <div className="flex flex-col gap-4">
        {days.map((d) => {
          const isToday = sameDay(d, today);
          const past = d.getTime() < today.getTime();
          const allDay = items.filter((p) => p.isAllDay && onDay(p, d));
          const timed = items.filter((p) => !p.isAllDay && onDay(p, d)).sort((a, b) => a.start.getTime() - b.start.getTime());
          const nowIdx = isToday ? timed.findIndex((p) => p.start.getTime() > now.getTime()) : -2;
          return (
            <div key={d.getTime()} data-day={d.getTime()} className="flex flex-col gap-3">
      {onOpenBriefing && isToday && (
        <button onClick={onOpenBriefing} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-2xl bg-slate-900 border border-slate-800 text-left">
          <Sunrise className="w-5 h-5 text-amber-400 shrink-0" />
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-semibold text-slate-100">Today's briefing</span>
            <span className="block text-[12.5px] text-slate-400 truncate">{todaysAllDay.length ? todaysAllDay.map((p) => p.name).join(" · ") : "Your day at a glance"}</span>
          </span>
          <span className="text-[13px] font-semibold text-blue-300">Open</span>
        </button>
      )}
            <section className={`grid grid-cols-[48px_minmax(0,1fr)] gap-2 ${past ? "opacity-60" : ""}`}>
              <button onClick={() => onPickDay(d)} className="flex flex-col items-center gap-0.5 pt-0.5 self-start" aria-label={`Open ${d.toDateString()}`}>
                <span className={`text-[11px] font-bold tracking-[0.06em] ${isToday ? "text-blue-300" : "text-slate-400"}`}>{DOW[(d.getDay() + 6) % 7]}</span>
                <span className={`w-9 h-9 rounded-full flex items-center justify-center text-lg ${isToday ? "bg-blue-600 text-white font-semibold" : "text-slate-200"}`}>{d.getDate()}</span>
              </button>
              <div className="flex flex-col gap-1.5 min-w-0">
                {allDay.map((p) => (
                  <AllDayChip key={`${p.id}-ad`} p={p} onSelect={onSelect} />
                ))}
                {timed.map((p, i) => (
                  <div key={`${p.id}-${p.start.getTime()}`} className="flex flex-col gap-1.5">
                    {i === nowIdx && <NowRule />}
                    <ScheduleCard p={p} onSelect={onSelect} />
                  </div>
                ))}
                {isToday && timed.length > 0 && nowIdx === -1 && <NowRule />}
                {!allDay.length && !timed.length && <p className="pt-2.5 text-[13px] text-slate-500">Nothing planned</p>}
              </div>
            </section>
            </div>
          );
        })}
      </div>
      <button onClick={() => onStepWeek(1)} className="w-full mt-4 py-3 rounded-xl bg-slate-900 border border-slate-800 text-sm font-semibold text-blue-300">
        Next week ›
      </button>
    </div>
  );
}

function NowRule() {
  return (
    <div className="flex items-center h-2.5 -ml-1.5" aria-label="Now">
      <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
      <span className="flex-1 h-0.5 bg-red-500" />
    </div>
  );
}

/* ---------------------------------------------------------------- Time grid */

function TimeGrid({
  view,
  items,
  anchor,
  now,
  onSelect,
  onPickDay,
  onAddAt,
}: {
  view: "day" | "3day" | "week";
  items: PlacedItem[];
  anchor: Date;
  now: Date;
  onSelect: (p: PlacedItem) => void;
  onPickDay: (d: Date) => void;
  onAddAt: (d: Date | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const weekStart = getWeekStart(anchor);
  const days =
    view === "day" ? [anchor] : view === "week" ? Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)) : [0, 1, 2].map((i) => addDays(threeDayStart(anchor), i));
  const hourPx = view === "week" ? 44 : view === "3day" ? 48 : 52;
  const gutter = view === "week" ? 36 : 48;
  const hours = Array.from({ length: GRID_END_HOUR - GRID_START_HOUR }, (_, i) => GRID_START_HOUR + i);
  const today = startOfDay(now);

  // Open at the current time today, otherwise at 07:00.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const showsToday = days.some((d) => sameDay(d, today));
    const hour = showsToday ? Math.max(0, now.getHours() - 1) : 7;
    el.scrollTop = (hour - GRID_START_HOUR) * hourPx;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, anchor.getTime()]);

  const cols = days.map((d) => {
    const timed = items.filter((p) => !p.isAllDay && onDay(p, d)).sort((a, b) => a.start.getTime() - b.start.getTime());
    return { d, allDay: items.filter((p) => p.isAllDay && onDay(p, d)), timed, layout: layoutColumns(timed) };
  });
  const maxAllDay = view === "day" ? 99 : 2;
  const compact = view !== "day";

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Headers */}
      {view === "day" ? (
        <div className="shrink-0 grid grid-cols-7 px-2 pb-1.5">
          {Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).map((d) => {
            const sel = sameDay(d, anchor);
            const isToday = sameDay(d, today);
            const has = items.some((p) => onDay(p, d));
            return (
              <button key={d.getTime()} onClick={() => onPickDay(d)} className="flex flex-col items-center gap-1 py-0.5">
                <span className={`text-[11px] font-semibold tracking-wide ${sel || isToday ? "text-blue-300" : "text-slate-500"}`}>{DOW[dayIdx(d)]}</span>
                <span
                  className={`w-[34px] h-[34px] rounded-full flex items-center justify-center text-base font-semibold ${
                    sel ? "bg-blue-600 text-white" : isToday ? "text-blue-300" : "text-slate-200"
                  }`}
                >
                  {d.getDate()}
                </span>
                <span className={`w-1 h-1 rounded-full ${has && !sel ? "bg-slate-500" : "bg-transparent"}`} />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="shrink-0 flex pb-1.5">
          <div style={{ width: gutter }} className="shrink-0" />
          {days.map((d) => {
            const isToday = sameDay(d, today);
            return (
              <button key={d.getTime()} onClick={() => onPickDay(d)} className="flex-1 min-w-0 flex flex-col items-center gap-0.5">
                <span className={`text-[11px] font-semibold tracking-wide ${isToday ? "text-blue-300" : "text-slate-500"}`}>{DOW[(d.getDay() + 6) % 7]}</span>
                <span className={`${view === "week" ? "w-7 h-7 text-sm" : "w-9 h-9 text-lg"} rounded-full flex items-center justify-center font-semibold ${isToday ? "bg-blue-600 text-white" : "text-slate-200"}`}>
                  {d.getDate()}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* All-day */}
      {cols.some((c) => c.allDay.length) && (
        <div className="shrink-0 flex border-b border-slate-800 pb-1.5 pr-1">
          <div style={{ width: gutter }} className="shrink-0" />
          {cols.map((c) => (
            <div key={c.d.getTime()} className="flex-1 min-w-0 flex flex-col gap-[3px] px-[1.5px]">
              {c.allDay.slice(0, maxAllDay).map((p) => (
                <AllDayChip key={p.id} p={p} onSelect={onSelect} small={compact} />
              ))}
              {c.allDay.length > maxAllDay && (
                <button onClick={() => onPickDay(c.d)} className="text-[10px] text-slate-400 text-left px-1">
                  +{c.allDay.length - maxAllDay} more
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Hours */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="relative flex" style={{ height: hours.length * hourPx + 90 }}>
          <div style={{ width: gutter }} className="shrink-0 relative">
            {hours.map((h) => (
              <span key={h} className="absolute right-1.5 -translate-y-1/2 text-[10.5px] text-slate-500 tabular-nums" style={{ top: (h - GRID_START_HOUR) * hourPx }}>
                {h === GRID_START_HOUR ? "" : view === "week" ? String(h).padStart(2, "0") : `${String(h).padStart(2, "0")}:00`}
              </span>
            ))}
          </div>
          <div className="flex-1 relative pr-1">
            {hours.map((h) => (
              <div key={h} className="absolute left-0 right-0 h-px bg-slate-800/70" style={{ top: (h - GRID_START_HOUR) * hourPx }} />
            ))}
            <div className="absolute inset-0 flex">
              {cols.map((c) => (
                <div
                  key={c.d.getTime()}
                  className={`relative flex-1 min-w-0 ${days.length > 1 ? "border-l border-slate-800/70" : ""}`}
                  onClick={(e) => {
                    if (e.target !== e.currentTarget) return;
                    const y = e.nativeEvent.offsetY;
                    const mins = Math.floor(y / hourPx * 4) * 15 + GRID_START_HOUR * 60;
                    const at = new Date(c.d);
                    at.setHours(0, mins, 0, 0);
                    onAddAt(at);
                  }}
                >
                  {c.timed.map((p, i) => {
                    const top = ((p.start.getHours() - GRID_START_HOUR) * 60 + p.start.getMinutes()) * (hourPx / 60);
                    const height = Math.max(compact ? 18 : 20, ((p.end.getTime() - p.start.getTime()) / 60000) * (hourPx / 60) - 2);
                    const k = cardClasses(p);
                    const tall = height >= 36;
                    const enroute = p.kind === "Enroute";
                    return (
                      <button
                        key={`${p.id}-${p.start.getTime()}`}
                        onClick={enroute ? undefined : () => onSelect(p)}
                        className={`absolute rounded-md overflow-hidden text-left ${compact ? "px-1 py-0.5" : "px-2 py-1"} ${k.box}`}
                        style={{ top, height, ...layoutStyle(c.layout[i]) }}
                      >
                        <span className={`block ${compact ? "text-[11px] leading-tight" : "text-[12.5px] leading-snug"} font-semibold ${tall ? "" : "truncate"} ${p.completed ? "line-through" : ""}`}>
                          {p.name}
                        </span>
                        {tall && !(view === "week") && <span className={`block text-[11px] ${k.sub}`}>{hhmm(p.start)}–{hhmm(p.end)}</span>}
                      </button>
                    );
                  })}
                  {sameDay(c.d, today) && (
                    <div
                      className="absolute left-0 right-0 z-10 pointer-events-none flex items-center"
                      style={{ top: ((now.getHours() - GRID_START_HOUR) * 60 + now.getMinutes()) * (hourPx / 60) - 5 }}
                      aria-label="Now"
                    >
                      <span className="w-2.5 h-2.5 -ml-1.5 rounded-full bg-red-500" />
                      <span className="flex-1 h-0.5 bg-red-500" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Month */

function MonthGrid({
  items,
  anchor,
  gridStart,
  onPickDay,
  onPickMonth,
}: {
  items: PlacedItem[];
  anchor: Date;
  gridStart: Date;
  onPickDay: (d: Date) => void;
  onPickMonth: (d: Date) => void;
}) {
  const today = startOfDay(new Date());
  const chips = Array.from({ length: 7 }, (_, i) => new Date(anchor.getFullYear(), anchor.getMonth() - 1 + i, 1));
  // Only as many rows as the month needs (5 or 6).
  const lastOfMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const rows = Math.ceil((Math.round((startOfDay(lastOfMonth).getTime() - gridStart.getTime()) / DAY_MS) + 1) / 7);
  const weeks = Array.from({ length: rows }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(gridStart, w * 7 + i)));

  return (
    <div className="flex-1 min-h-0 flex flex-col pb-20">
      <div className="shrink-0 flex gap-2 px-3 pb-2 overflow-x-auto no-scrollbar">
        {chips.map((m) => {
          const on = m.getMonth() === anchor.getMonth() && m.getFullYear() === anchor.getFullYear();
          return (
            <button
              key={m.getTime()}
              onClick={() => onPickMonth(m)}
              className={`shrink-0 h-8 px-3.5 rounded-full border text-[13.5px] font-semibold ${on ? "border-blue-500 bg-blue-600/25 text-blue-100" : "border-slate-700 text-slate-300"}`}
            >
              {m.toLocaleDateString("en-US", { month: "short" })}
              {m.getMonth() === 0 || m.getFullYear() !== today.getFullYear() ? ` ${m.getFullYear()}` : ""}
            </button>
          );
        })}
      </div>
      <div className="shrink-0 grid grid-cols-7 border-b border-slate-800 px-0.5">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={i} className="text-center text-[11px] font-semibold text-slate-500 pb-1.5">
            {d}
          </span>
        ))}
      </div>
      <div className="flex-1 min-h-0 flex flex-col px-0.5">
        {weeks.map((wk, wi) => (
          <div key={wi} className="flex-1 min-h-0 grid grid-cols-7 border-b border-slate-800/60">
            {wk.map((d) => {
              const inMonth = d.getMonth() === anchor.getMonth();
              const isToday = sameDay(d, today);
              const list = items
                .filter((p) => onDay(p, d))
                .sort((a, b) => Number(!!b.isAllDay) - Number(!!a.isAllDay) || a.start.getTime() - b.start.getTime());
              const shown = list.slice(0, 4);
              return (
                <button key={d.getTime()} onClick={() => onPickDay(d)} className={`min-w-0 overflow-hidden flex flex-col gap-[2px] pt-1 px-[1px] ${inMonth ? "" : "opacity-50"}`}>
                  <span className={`self-center w-[22px] h-[22px] rounded-full flex items-center justify-center text-xs font-semibold ${isToday ? "bg-blue-600 text-white" : "text-slate-200"}`}>
                    {d.getDate()}
                  </span>
                  {shown.map((p) => {
                    const c = getPillarColor(p.pillar);
                    return (
                      <span key={`${p.id}-${p.start.getTime()}`} className={`block h-[15px] leading-[15px] rounded-[3px] px-[3px] text-[9.5px] font-semibold whitespace-nowrap overflow-hidden text-left ${c.bg} ${c.text} ${p.completed ? "opacity-50" : ""}`}>
                        {p.name}
                      </span>
                    );
                  })}
                  {list.length > shown.length && <span className="text-[10px] text-slate-400 text-left pl-[3px]">+{list.length - shown.length}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
