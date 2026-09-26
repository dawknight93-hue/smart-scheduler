import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Plus, TrendingDown, TrendingUp, Trash2 } from "lucide-react";
import { formatLocalDate } from "@/lib/recurrence";
import { addEntry, deleteEntry, fmt, outcomeStatus, WEEKDAYS, type GoalMeasure, type MeasureEntry } from "@/lib/measures";

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
}: {
  measure: GoalMeasure;
  entries: MeasureEntry[];
  onChange: (entries: MeasureEntry[]) => void;
  showHistory?: boolean;
}) {
  const s = outcomeStatus(measure, entries);
  const [value, setValue] = useState("");
  const [date, setDate] = useState(() => formatLocalDate(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
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
      <div className="flex items-start gap-3">
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
              {s.onTrack === null ? null : s.onTrack ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <AlertTriangle className="w-3 h-3 text-amber-400" />}
              <span className={s.onTrack === null ? "text-slate-400" : s.onTrack ? "text-emerald-300" : "text-amber-300"}>
                Next checkpoint {cmp} {fmt(s.next.target)}
                {unit} by {shortDate(s.next.due)} ({s.daysToNext} day{s.daysToNext === 1 ? "" : "s"})
                {s.onTrack === null ? "" : s.onTrack ? " — on track" : ` — behind${s.expected !== null ? ` (aim for ${fmt(Math.round(s.expected * 10) / 10)}${unit} about now)` : ""}`}
              </span>
            </p>
          )}
          {s.past.length > 0 && (
            <p className="text-[11px] text-slate-500 mt-0.5">
              {s.past
                .slice(-2)
                .map((c) => `${shortDate(c.due)} ${cmp} ${fmt(c.target)}${unit}: ${c.met === null ? "not logged" : c.met ? "met" : "missed"}`)
                .join(" · ")}
            </p>
          )}
          {s.due && (
            <p className="text-[11px] text-amber-300 mt-0.5">
              Due{measure.log_every === "weekly" && measure.log_weekday !== null ? ` (${WEEKDAYS[measure.log_weekday]}s)` : measure.log_every === "daily" ? " today" : ""} — log your number
            </p>
          )}
        </div>
        <Sparkline m={measure} entries={mine} />
      </div>

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
      {error && <p className="mt-1 text-xs text-rose-300">{error}</p>}

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
                {confirmDel === e.id ? (
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
    </div>
  );
}
