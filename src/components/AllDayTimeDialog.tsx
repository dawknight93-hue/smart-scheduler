import { useState } from "react";
import { Clock, Loader2, X } from "lucide-react";

const QUICK = [30, 45, 60, 90];
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
function span(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/**
 * An all-day event dropped on a time: it starts where you let go; pick when it ends.
 * Save turns it into a timed event (in Google too, if it came from there).
 */
export function AllDayTimeDialog({
  name,
  start,
  saving,
  error,
  onSave,
  onCancel,
}: {
  name: string;
  start: Date;
  saving: boolean;
  error: string | null;
  /** `details`: open the full editor after saving. */
  onSave: (end: Date, busy: boolean, details: boolean) => void;
  onCancel: () => void;
}) {
  const [minutes, setMinutes] = useState(30);
  const [busy, setBusy] = useState(true);
  const end = new Date(start.getTime() + minutes * 60000);
  // End-time choices: every 15 minutes for up to 12 hours, not past midnight.
  const options: number[] = [];
  for (let m = 15; m <= 12 * 60; m += 15) {
    const e = new Date(start.getTime() + m * 60000);
    if (e.getDate() !== start.getDate() && !(e.getHours() === 0 && e.getMinutes() === 0)) break;
    options.push(m);
  }
  const day = start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 backdrop-blur-sm sm:p-4" onClick={onCancel}>
      <div
        className="w-full sm:max-w-sm bg-slate-900 border-t sm:border border-slate-700 rounded-t-3xl sm:rounded-2xl px-5 pt-4 pb-[calc(20px+env(safe-area-inset-bottom))] sm:pb-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-slate-400">
              <Clock className="h-3.5 w-3.5" /> Give it a time
            </div>
            <h3 className="mt-1 truncate text-base font-semibold text-slate-100">{name}</h3>
          </div>
          <button onClick={onCancel} className="rounded p-1 hover:bg-slate-800" aria-label="Cancel">
            <X className="h-4 w-4 text-slate-400" />
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs text-slate-400">Starts</div>
            <div className="mt-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm tabular-nums text-slate-200">
              {day} · {hhmm(start)}
            </div>
          </div>
          <label className="text-xs text-slate-400">
            Ends
            <select
              className="input mt-1 tabular-nums"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              autoFocus
            >
              {options.map((m) => (
                <option key={m} value={m}>
                  {hhmm(new Date(start.getTime() + m * 60000))} ({span(m)})
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {QUICK.filter((q) => options.includes(q)).map((q) => (
            <button
              key={q}
              onClick={() => setMinutes(q)}
              className={`rounded-full border px-2.5 py-1 text-xs ${minutes === q ? "border-blue-500 bg-blue-600 text-white" : "border-slate-700 text-slate-300 hover:bg-slate-800"}`}
            >
              {span(q)}
            </button>
          ))}
        </div>

        <label className="mt-4 flex items-start gap-2 text-sm text-slate-300">
          <input type="checkbox" className="mt-0.5 accent-blue-500" checked={busy} onChange={(e) => setBusy(e.target.checked)} />
          <span>
            Block this time
            <span className="block text-[11px] text-slate-500">The planner keeps tasks out of {hhmm(start)}–{hhmm(end)}. Untick to show it without blocking.</span>
          </span>
        </label>

        {error && <div className="mt-3 rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">{error}</div>}

        <div className="mt-4 flex gap-2">
          <button
            onClick={() => onSave(end, busy, true)}
            disabled={saving}
            className="flex-1 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            More options
          </button>
          <button
            onClick={() => onSave(end, busy, false)}
            disabled={saving}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
          </button>
        </div>
      </div>
    </div>
  );
}
