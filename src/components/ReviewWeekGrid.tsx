import { useEffect, useMemo, useRef } from "react";
import type { PlacedItem } from "@/lib/types";
import { getPillarColor } from "@/lib/types";
import { addDays, runEngine } from "@/lib/schedulingEngine";
import { layoutColumns, type ItemLayout } from "@/lib/calendarLayout";
import type { GoalWeekPlan, WeekData } from "@/lib/goalPlanning";
import { planKey } from "@/lib/measures";

/**
 * The review's week, beside the cards: what's already on the calendar, plus
 * each card's proposed sessions as dashed blocks (until you approve or skip).
 * Tapping a card highlights its sessions here; tapping a block selects its card.
 */

const HOUR_PX = 40;
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const QUIET_START = 21;
const QUIET_END = 9;
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

interface Block {
  key: string;
  name: string;
  start: Date;
  end: Date;
  pillar: PlacedItem["pillar"];
  proposed: boolean;
  /** planKey of the card this block belongs to, if any. */
  owner?: string;
  muted?: boolean;
}

function layoutStyle(l: ItemLayout | undefined): React.CSSProperties {
  if (!l || l.cols === 1) return { left: 1, right: 1 };
  const w = 100 / l.cols;
  return { left: `calc(${l.col * w}% + 1px)`, width: `calc(${l.span * w}% - 2px)` };
}

export function ReviewWeekGrid({
  week,
  plans,
  removed,
  reviewedKeys,
  selectedKey,
  onSelect,
}: {
  week: WeekData;
  plans: GoalWeekPlan[];
  removed: Set<string>;
  /** Cards already approved or skipped: their proposals are gone. */
  reviewedKeys: Set<string>;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week.weekStart, i));
  const today = new Date().toDateString();

  const { allDay, timed } = useMemo(() => {
    const r = runEngine(week.weekStart, week.busy, week.habits, week.tasks);
    // Which card owns each session already on the calendar (🎯 goal sessions).
    const ownerOf = new Map<string, string>();
    for (const p of plans) for (const h of p.existing) ownerOf.set(h.id, planKey(p.goal));
    const allDay: Block[] = [];
    const timed: Block[] = [];
    for (const p of r.placed) {
      if (p.kind === "Enroute") continue;
      const fe = week.fixedById.get(p.id.split("--")[0]);
      const long = p.end.getTime() - p.start.getTime() >= 20 * 3600000;
      const b: Block = {
        key: `${p.id}-${p.start.getTime()}`,
        name: p.name,
        start: p.start,
        end: p.end,
        pillar: p.pillar,
        proposed: false,
        owner: ownerOf.get(p.id.split("--")[0]),
        muted: p.kind === "Fixed Event" && p.blocksSchedule === false,
      };
      if (fe?.is_all_day || long) {
        // All-day events are stored at UTC midnights.
        const s = fe?.is_all_day ? new Date(p.start.getUTCFullYear(), p.start.getUTCMonth(), p.start.getUTCDate()) : p.start;
        const e = fe?.is_all_day ? new Date(p.end.getUTCFullYear(), p.end.getUTCMonth(), p.end.getUTCDate()) : p.end;
        allDay.push({ ...b, start: s, end: e });
      } else timed.push(b);
    }
    for (const p of plans) {
      const key = planKey(p.goal);
      if (reviewedKeys.has(key)) continue;
      for (const s of p.proposed) {
        if (removed.has(s.key)) continue;
        timed.push({ key: s.key, name: p.goal.weekly_target ?? "Session", start: s.start, end: s.end, pillar: p.goal.pillar, proposed: true, owner: key });
      }
    }
    return { allDay, timed };
  }, [week, plans, removed, reviewedKeys]);

  const cols = days.map((d) => {
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const e = s + 86400000;
    const mine = timed.filter((b) => b.start.getTime() >= s && b.start.getTime() < e).sort((a, b) => a.start.getTime() - b.start.getTime());
    const asItems = mine.map((b) => ({ start: b.start, end: b.end }) as PlacedItem);
    return { d, blocks: mine, layout: layoutColumns(asItems), allDay: allDay.filter((b) => b.start.getTime() < e && b.end.getTime() > s) };
  });
  const maxAllDay = Math.max(0, ...cols.map((c) => c.allDay.length));

  // Open at 06:00.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 6 * HOUR_PX - 4;
  }, [week.weekStart]);

  const proposedCount = timed.filter((b) => b.proposed).length;

  return (
    <div className="h-full min-h-0 flex flex-col rounded-xl border border-slate-700 bg-slate-900/60 overflow-hidden">
      <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-slate-800 text-[11px] text-slate-400">
        <span className="font-semibold text-slate-200 text-xs">This week on your calendar</span>
        {proposedCount > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-2.5 rounded-sm border border-dashed border-slate-300" /> {proposedCount} proposed, not yet approved
          </span>
        )}
        {selectedKey && (
          <button onClick={() => onSelect(null)} className="ml-auto text-blue-400 hover:underline">
            Clear highlight
          </button>
        )}
      </div>

      {/* Day headers */}
      <div className="shrink-0 flex border-b border-slate-800">
        <div className="w-11 shrink-0" />
        {cols.map((c, i) => (
          <div key={i} className="flex-1 min-w-0 px-1 py-1.5 text-center border-l border-slate-800">
            <span className={`text-[11px] font-semibold ${c.d.toDateString() === today ? "text-blue-300" : "text-slate-400"}`}>
              {DOW[i]} {c.d.getDate()}
            </span>
          </div>
        ))}
      </div>

      {/* All-day */}
      {maxAllDay > 0 && (
        <div className="shrink-0 flex border-b border-slate-800 py-1">
          <div className="w-11 shrink-0 text-[9px] uppercase text-slate-500 text-right pr-1.5 pt-0.5">all day</div>
          {cols.map((c, i) => (
            <div key={i} className="flex-1 min-w-0 px-0.5 flex flex-col gap-0.5 border-l border-slate-800">
              {c.allDay.map((b) => {
                const k = getPillarColor(b.pillar);
                return (
                  <span key={b.key} className={`block truncate rounded px-1 text-[10px] font-semibold leading-4 ${k.bg} ${k.text} ${b.muted ? "opacity-60" : ""}`} title={b.name}>
                    {b.name}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Hours */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        <div className="relative flex" style={{ height: 24 * HOUR_PX }}>
          <div className="w-11 shrink-0 relative">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="absolute right-1.5 -translate-y-1/2 text-[10px] text-slate-500 tabular-nums" style={{ top: h * HOUR_PX }}>
                {h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}
              </span>
            ))}
          </div>
          <div className="flex-1 relative">
            {/* Quiet hours */}
            <div className="absolute inset-x-0 top-0 bg-slate-950/60 pointer-events-none" style={{ height: QUIET_END * HOUR_PX }} />
            <div className="absolute inset-x-0 bg-slate-950/60 pointer-events-none" style={{ top: QUIET_START * HOUR_PX, height: (24 - QUIET_START) * HOUR_PX }} />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="absolute inset-x-0 h-px bg-slate-800/70" style={{ top: h * HOUR_PX }} />
            ))}
            <div className="absolute inset-0 flex">
              {cols.map((c, ci) => (
                <div key={ci} className="relative flex-1 min-w-0 border-l border-slate-800">
                  {c.blocks.map((b, i) => {
                    const top = (b.start.getHours() * 60 + b.start.getMinutes()) * (HOUR_PX / 60);
                    const height = Math.max(16, ((b.end.getTime() - b.start.getTime()) / 60000) * (HOUR_PX / 60) - 1);
                    const k = getPillarColor(b.pillar);
                    const lit = !!selectedKey && b.owner === selectedKey;
                    const dim = !!selectedKey && !lit;
                    return (
                      <button
                        key={b.key}
                        type="button"
                        onClick={() => b.owner && onSelect(b.owner === selectedKey ? null : b.owner)}
                        title={`${b.name} · ${hhmm(b.start)}–${hhmm(b.end)}${b.proposed ? " (proposed)" : ""}`}
                        className={`absolute overflow-hidden rounded-[4px] px-1 text-left text-[10px] leading-tight font-semibold ${
                          b.proposed ? `border-2 border-dashed ${k.border} ${k.soft} text-slate-100` : `${k.bg} ${k.text}`
                        } ${b.muted ? "opacity-60" : ""} ${dim ? "opacity-30" : ""} ${lit ? "ring-2 ring-white z-10" : ""} ${b.owner ? "cursor-pointer" : "cursor-default"}`}
                        style={{ top, height, ...layoutStyle(c.layout[i]) }}
                      >
                        <span className="block truncate">{b.name}</span>
                        {height >= 30 && <span className="block truncate font-normal opacity-80">{hhmm(b.start)}</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
