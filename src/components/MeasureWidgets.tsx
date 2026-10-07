import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, Plus, TrendingDown, TrendingUp, Trash2 } from "lucide-react";
import { formatLocalDate } from "@/lib/recurrence";
import { addEntry, checkpointWord, deleteEntry, fmt, outcomeStatus, paceLadder, withUnit, WEEKDAYS, type GoalMeasure, type MeasureEntry } from "@/lib/measures";
import { completeGoal } from "@/lib/goalCompletion";

const shortDate = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/** Tiny trend line of logged values (with the target as a dashed line). */
function Sparkline({ m, entries }: { m: GoalMeasure; entries: MeasureEntry[] }) {
  const pts = entries.slice(-12);
  if (pts.length < 2) return null;
  const vals = [...pts.map((e) => e.value), ...(m.target !== null ? [m.target] : [])];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const W = 120;
  const H = 28;
  const x = (i: number) => (i / (pts.length - 1)) * (W - 4) + 2;
  const y = (v: number) => H - 3 - ((v - lo) / span) * (H - 6);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" aria-hidden="true">
      {m.target !== null && <line x1={2} x2={W - 2} y1={y(m.target)} y2={y(m.target)} stroke="currentColor" className="text-emerald-500/50" strokeDasharray="3 3" />}
      <polyline fill="none" stroke="currentColor" className="text-blue-400" strokeWidth={1.75} points={pts.map((e, i) => `${x(i)},${y(e.value)}`).join(" ")} />
      <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1].value)} r={2.5} fill="currentColor" className="text-blue-300" />
    </svg>
  );
}

/**
 * An outcome measure: where you are, the next checkpoint, whether you're on
 * track, and a quick way to log today's number.
 */
export function OutcomeTracker({
  measure,
  entries,
  onChange,
  showHistory = false,
  deadline,
  defaultOpen,
  countedFrom,
}: {
  measure: GoalMeasure;
  entries: MeasureEntry[];
  onChange: (entries: MeasureEntry[]) => void;
  showHistory?: boolean;
  /** The goal's deadline, for the week/month/quarter/year pace. */
  deadline?: string | null;
  /** Start expanded (remembered per number after you open or close it). */
  defaultOpen?: boolean;
  /** For a number that counts an effort's ticks: that effort's name. */
  countedFrom?: string;
}) {
  const s = outcomeStatus(measure, entries);
  const ladder = paceLadder(measure, entries, deadline);
  // Collapsible: the header stays as a summary; pace, logging and history open below it.
  const openKey = `smartScheduler.outcomeOpen.${measure.id}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = window.localStorage.getItem(openKey);
      if (v === "1" || v === "0") return v === "1";
    } catch {
      // storage unavailable
    }
    return defaultOpen ?? showHistory;
  });
  const toggle = () =>
    setOpen((o) => {
      try {
        window.localStorage.setItem(openKey, o ? "0" : "1");
      } catch {
        // storage unavailable
      }
      return !o;
    });
  // Things you count (check-ins, nights, items) read in whole numbers, not "0.3 a week".
  const integral = [measure.baseline ?? 0, measure.target ?? 0, ...measure.checkpoints.map((c) => c.target)].every((v) => Number.isInteger(v));
  const [value, setValue] = useState("");
  const [date, setDate] = useState(() => formatLocalDate(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  // Set when a logged number reaches the goal's target: offer to finish the goal.
  const [reached, setReached] = useState<null | "ask" | "done">(null);
  const [reachedValue, setReachedValue] = useState<number | null>(null);
  const unit = measure.unit ? ` ${measure.unit}` : "";
  const cmp = measure.direction === "up" ? "≥" : "≤";
  const Trend = measure.direction === "up" ? TrendingUp : TrendingDown;

  async function log() {
    const v = Number(value);
    if (!value.trim() || !Number.isFinite(v)) return;
    setBusy(true);
    setError(null);
    try {
      const e = await addEntry(measure, v, date);
      onChange([...entries, e]);
      setValue("");
      if (measure.target !== null && (measure.direction === "up" ? v >= measure.target : v <= measure.target)) {
        setReachedValue(v);
        setReached("ask");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await deleteEntry(id);
      onChange(entries.filter((e) => e.id !== id));
      setConfirmDel(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete");
    }
  }

  const mine = entries.filter((e) => e.measure_id === measure.id).sort((a, b) => a.logged_on.localeCompare(b.logged_on));

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3">
      <button type="button" onClick={toggle} aria-expanded={open} className="w-full flex items-start gap-3 text-left">
        <Trend className="w-4 h-4 mt-0.5 text-blue-300 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium text-slate-100">{measure.label}</span>
            {s.latest ? (
              <span className="text-sm tabular-nums text-slate-200">
                {fmt(s.latest.value)}
                {unit}
                <span className="text-xs text-slate-500"> · {shortDate(s.latest.logged_on)}</span>
              </span>
            ) : (
              <span className="text-xs text-slate-500">nothing logged yet</span>
            )}
            {s.change !== null && measure.baseline !== null && (
              <span className={`text-xs tabular-nums ${(measure.direction === "up" ? s.change >= 0 : s.change <= 0) ? "text-emerald-300" : "text-amber-300"}`}>
                {s.change >= 0 ? "+" : ""}
                {fmt(Math.round(s.change * 10) / 10)}
                {unit} since start
              </span>
            )}
          </div>
          {s.next && (
            <p className="text-xs mt-0.5 flex items-center gap-1">
              {s.onTrack === null ? null : s.onTrack ? (
                <CheckCircle2 className="w-3 h-3 text-emerald-400" />
              ) : (
                <AlertTriangle className={`w-3 h-3 ${s.close ? "text-amber-400" : "text-rose-400"}`} />
              )}
              <span className={s.onTrack === null ? "text-slate-400" : s.onTrack ? "text-emerald-300" : s.close ? "text-amber-300" : "text-rose-300"}>
                Next checkpoint {cmp} {fmt(s.next.target)}
                {unit} by {shortDate(s.next.due)} ({s.daysToNext} day{s.daysToNext === 1 ? "" : "s"})
                {s.onTrack === null
                  ? ""
                  : s.onTrack
                    ? " — on track"
                    : ` — ${s.close ? "close" : "behind"}${
                        s.expected !== null && s.latest
                          ? `: a steady path there puts you at ${fmt(Math.round(s.expected * 10) / 10)}${unit} today; you're at ${fmt(s.latest.value)}${unit}`
                          : ""
                      }`}
              </span>
            </p>
          )}
          {s.replanned.length > 0 && (
            <p className="text-[11px] text-sky-300/90 mt-0.5" title="After a missed checkpoint, the later ones are re-spread from the number you actually logged; the final target doesn't move.">
              Re-planned from your actual number: {s.replanned.map((r) => `${shortDate(r.due)} ${cmp} ${fmt(r.now)}${unit} (was ${fmt(r.was)})`).join(" · ")}
            </p>
          )}
          {open && s.past.length > 0 && (
            <p className="text-[11px] text-slate-500 mt-0.5">
              {s.past.slice(-2).map((c, i) => (
                <span key={c.due}>
                  {i > 0 && " · "}
                  {shortDate(c.due)} {cmp} {fmt(c.target)}
                  {unit}:{" "}
                  <span className={c.met === null ? "" : c.met ? "text-emerald-300" : c.close ? "text-amber-300" : "text-rose-300"}>
                    {checkpointWord(c)}
                    {c.value !== null && !c.met ? ` (${fmt(c.value)}${unit})` : ""}
                  </span>
                </span>
              ))}
            </p>
          )}
          {s.due && (
            <p className="text-[11px] text-amber-300 mt-0.5">
              Due{measure.log_every === "weekly" && measure.log_weekday !== null ? ` (${WEEKDAYS[measure.log_weekday]}s)` : measure.log_every === "daily" ? " today" : ""} — log your number
            </p>
          )}
        </div>
        {open && <Sparkline m={measure} entries={mine} />}
        <ChevronDown className={`w-4 h-4 mt-0.5 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>

      {open && (
        <>

      {ladder.length > 0 && (
        <div className="mt-2 grid gap-1" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))" }}>
          {ladder.map((r) => {
            const sign = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "±");
            const amt = (v: number) => `${sign(v)}${withUnit(integral ? Math.round(Math.abs(v)) : Math.abs(v), measure.unit)}`;
            const aim = (v: number) => withUnit(integral ? Math.round(v) : v, measure.unit);
            const ahead = r.soFar !== null && (measure.direction === "up" ? r.soFar >= r.needed : r.soFar <= r.needed);
            const per = r.level === "week" ? "week" : r.level === "month" ? "month" : r.level === "quarter" ? "quarter" : "";
            const title = r.level === "goal" ? r.label : r.level === "year" ? `By end of ${r.short}` : `Per ${per}`;
            return (
              <div key={r.level} className={`rounded-md px-2 py-1.5 min-w-0 ${r.level === "goal" ? "bg-slate-900 border border-slate-700" : "bg-slate-900/60"}`}>
                <div className="text-[10px] uppercase tracking-wide text-slate-500 truncate">{title}</div>
                {r.level === "goal" ? (
                  <>
                    <div className="text-xs font-semibold text-slate-100 tabular-nums truncate">{withUnit(r.targetAtEnd, measure.unit)}</div>
                    <div className="text-[10.5px] text-slate-400 tabular-nums truncate">
                      {(measure.direction === "up" ? r.needed > 0 : r.needed < 0) ? `${amt(r.needed)} to go` : "reached"}
                    </div>
                  </>
                ) : r.level === "year" ? (
                  <>
                    <div className="text-xs font-semibold text-slate-100 tabular-nums truncate">{aim(r.targetAtEnd)}</div>
                    <div className={`text-[10.5px] tabular-nums truncate ${ahead ? "text-emerald-300" : "text-slate-400"}`}>
                      {r.soFar === null ? `${amt(r.needed)} this year` : `${amt(r.soFar)} of ${amt(r.needed)}`}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-xs font-semibold text-slate-100 tabular-nums truncate">
                      {r.rate === null ? "—" : integral && Math.abs(r.rate) > 0 && Math.abs(r.rate) < 0.95 ? `1 every ${Math.round(1 / Math.abs(r.rate))} ${per}s` : amt(r.rate)}
                    </div>
                    <div className={`text-[10.5px] tabular-nums truncate ${r.soFar === null ? "text-slate-500" : ahead ? "text-emerald-300" : "text-slate-400"}`}>
                      {r.short}:{" "}
                      {r.soFar === null
                        ? integral && Math.round(r.targetAtEnd) === Math.round(r.startValue)
                          ? "none due yet"
                          : `aim ${aim(r.targetAtEnd)}`
                        : `${amt(r.soFar)} so far`}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {measure.counts_measure_id ? (
        <p className="mt-2 text-[11px] text-sky-300/90">Counts itself: each ticked {countedFrom ?? "session"} adds 1 (tick them on the calendar or in Review).</p>
      ) : (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="number"
          inputMode="decimal"
          step="any"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void log()}
          placeholder={`${measure.label}${unit ? ` (${measure.unit})` : ""}`}
          className="w-32 rounded-lg bg-slate-950 border border-slate-700 px-2 py-1 text-sm text-slate-100 placeholder:text-slate-600"
        />
        <input type="date" value={date} max={formatLocalDate(new Date())} onChange={(e) => setDate(e.target.value)} className="rounded-lg bg-slate-950 border border-slate-700 px-2 py-1 text-sm text-slate-100" />
        <button onClick={() => void log()} disabled={busy || !value.trim()} className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-500 disabled:opacity-50">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Log
        </button>
      </div>
      )}
      {error && <p className="mt-1 text-xs text-rose-300">{error}</p>}
      {reached === "ask" && (
        <div className="mt-2 rounded-lg border border-emerald-600/40 bg-emerald-600/10 p-2.5">
          <p className="text-sm text-emerald-300">
            That's your target ({measure.direction === "up" ? "≥" : "≤"} {fmt(measure.target!)}
            {unit}). Mark the goal complete?
          </p>
          <div className="mt-1.5 flex gap-2">
            <button
              onClick={async () => {
                try {
                  await completeGoal(measure.goal_id, `Reached ${fmt(reachedValue ?? measure.target!)}${unit} (${measure.label})`);
                  setReached("done");
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Couldn't save");
                }
              }}
              className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs text-white hover:bg-emerald-500"
            >
              Mark complete
            </button>
            <button onClick={() => setReached(null)} className="rounded-lg px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800">
              Not yet
            </button>
          </div>
        </div>
      )}
      {reached === "done" && <p className="mt-2 text-xs text-emerald-300">Goal marked complete — its upcoming sessions were taken off your calendar.</p>}

      {showHistory && mine.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-slate-400">History ({mine.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {[...mine].reverse().map((e) => (
              <li key={e.id} className="flex items-center gap-2 text-xs text-slate-400 tabular-nums">
                <span className="w-16">{shortDate(e.logged_on)}</span>
                <span className="text-slate-200">
                  {fmt(e.value)}
                  {unit}
                </span>
                {e.id.startsWith("auto-") ? (
                  <span className="ml-auto text-[10px] text-slate-500">from a tick</span>
                ) : confirmDel === e.id ? (
                  <button onClick={() => void remove(e.id)} className="ml-auto rounded bg-rose-600 px-2 py-0.5 text-[11px] text-white">Delete</button>
                ) : (
                  <button onClick={() => setConfirmDel(e.id)} className="ml-auto p-0.5 rounded hover:bg-slate-700" aria-label="Delete entry">
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
        </>
      )}
    </div>
  );
}
