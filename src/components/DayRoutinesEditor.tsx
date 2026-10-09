import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { DEFAULT_ROUTINES, deleteDayRoutine, loadDayRoutines, saveDayRoutine, type DayRoutine } from "@/lib/dayRoutines";
import { blockKey } from "@/lib/lifeBlocks";
import { appSettings } from "@/lib/appSettings";

const p2 = (h: number) => `${String(h).padStart(2, "0")}:00`;

/**
 * Day routines: for each kind of day, the times goal sessions may be suggested.
 * The first routine (top to bottom) that matches a day wins; "Normal day" covers the rest.
 */
export function DayRoutinesEditor({ onClose }: { onClose: (changed: boolean) => void }) {
  const [rows, setRows] = useState<DayRoutine[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [newLabel, setNewLabel] = useState("");

  useEffect(() => {
    void loadDayRoutines().then(setRows);
  }, []);

  const field = "rounded-lg bg-slate-950 border border-slate-700 px-2 py-1.5 text-sm text-slate-100";
  const patch = (key: string, p: Partial<DayRoutine>) => setRows((rs) => (rs ?? []).map((r) => (r.key === key ? { ...r, ...p } : r)));

  async function persist(r: DayRoutine) {
    setBusy(r.key);
    setError(null);
    try {
      const saved = await saveDayRoutine(r);
      setRows((rs) => (rs ?? []).map((x) => (x.key === r.key ? saved : x)));
      setChanged(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    const label = newLabel.trim();
    if (!label || !rows) return;
    const others = rows.filter((r) => r.kind !== "default");
    const r: DayRoutine = { key: blockKey(label), label, kind: "keywords", keywords: label.toLowerCase(), windows: [{ from: "09:00", to: "12:00" }], enabled: true, position: (others[others.length - 1]?.position ?? 40) + 10 };
    setBusy("new");
    try {
      const saved = await saveDayRoutine(r);
      setRows([...rows, saved].sort((a, b) => a.position - b.position));
      setNewLabel("");
      setChanged(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(null);
    }
  }

  async function remove(r: DayRoutine) {
    setBusy(r.key);
    try {
      await deleteDayRoutine(r);
      setRows((rs) => (rs ?? []).filter((x) => x.key !== r.key));
      setChanged(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete");
    } finally {
      setBusy(null);
    }
  }

  const isStarter = (r: DayRoutine) => DEFAULT_ROUTINES.some((d) => d.key === r.key);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 sm:p-4" onClick={() => onClose(changed)}>
      <div
        className="w-full sm:max-w-xl max-h-[88dvh] overflow-y-auto rounded-t-3xl sm:rounded-2xl border border-slate-700 bg-slate-900 p-5 pb-[calc(20px+env(safe-area-inset-bottom))] sm:pb-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Day routines</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              When the Weekly Review may suggest goal sessions, by kind of day. Each day takes the first routine (top to bottom) whose words appear on an all-day or 8h+ event that day{appSettings.features.trips ? `; Flying is any day with a flight leg or a layover away from ${appSettings.homeAirport}` : ""}. Sessions never go in quiet hours ({p2(appSettings.quietStartHour)}–{p2(appSettings.quietEndHour)}). A routine with no times means no goal sessions that day — they move to the nearest day with room.
            </p>
          </div>
          <button onClick={() => onClose(changed)} className="ml-auto p-1.5 rounded-lg hover:bg-slate-800" aria-label="Close">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>
        {error && <p className="mb-2 text-sm text-rose-300">{error}</p>}
        {!rows ? (
          <p className="flex items-center gap-2 text-sm text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.key} className={`rounded-lg border px-3 py-2.5 ${r.enabled ? "border-slate-700 bg-slate-800/60" : "border-slate-800 opacity-60"}`}>
                <div className="flex items-center gap-2">
                  {r.kind !== "default" && (
                    <input type="checkbox" checked={r.enabled} onChange={() => void persist({ ...r, enabled: !r.enabled })} className="accent-blue-500" aria-label={`Use ${r.label}`} />
                  )}
                  <input
                    className="flex-1 min-w-0 bg-transparent text-sm font-medium text-slate-100 outline-none focus:underline"
                    value={r.label}
                    onChange={(e) => patch(r.key, { label: e.target.value })}
                    onBlur={() => void persist(r)}
                  />
                  {busy === r.key && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
                  {!isStarter(r) && r.id && (
                    <button onClick={() => void remove(r)} className="p-1 rounded hover:bg-slate-700" aria-label={`Delete ${r.label}`}>
                      <Trash2 className="w-3.5 h-3.5 text-slate-500" />
                    </button>
                  )}
                </div>
                {r.kind === "keywords" && (
                  <label className="mt-1.5 block text-[11px] text-slate-400">
                    Title words (comma-separated)
                    <input className={`${field} mt-1 w-full`} value={r.keywords} onChange={(e) => patch(r.key, { keywords: e.target.value })} onBlur={() => void persist(r)} />
                  </label>
                )}
                {r.kind === "trips" && <p className="mt-1 text-[11px] text-slate-500">Any day with a flight leg, or away from {appSettings.homeAirport} between legs (from your crew schedule).</p>}
                {r.kind === "default" && <p className="mt-1 text-[11px] text-slate-500">Every day that matches none of the routines above.</p>}
                <div className="mt-2 space-y-1.5">
                  <div className="text-[11px] text-slate-400">Goal sessions may be suggested</div>
                  {r.windows.length === 0 && <p className="text-[11px] text-amber-300/90">Not at all on these days.</p>}
                  {r.windows.map((w, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        type="time"
                        step={900}
                        className={field}
                        value={w.from}
                        onChange={(e) => patch(r.key, { windows: r.windows.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })}
                        onBlur={() => void persist(r)}
                      />
                      <span className="text-xs text-slate-500">to</span>
                      <input
                        type="time"
                        step={900}
                        className={field}
                        value={w.to}
                        onChange={(e) => patch(r.key, { windows: r.windows.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })}
                        onBlur={() => void persist(r)}
                      />
                      <button
                        onClick={() => void persist({ ...r, windows: r.windows.filter((_, j) => j !== i) })}
                        className="p-1 rounded hover:bg-slate-700"
                        aria-label="Remove these times"
                      >
                        <X className="w-3.5 h-3.5 text-slate-500" />
                      </button>
                    </div>
                  ))}
                  <button onClick={() => void persist({ ...r, windows: [...r.windows, { from: "09:00", to: "12:00" }] })} className="text-xs text-blue-400 hover:underline">
                    + Add times
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex gap-2">
          <input
            className={`${field} flex-1`}
            placeholder="Add a kind of day, e.g. Training day"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void add()}
          />
          <button onClick={() => void add()} disabled={!newLabel.trim() || busy === "new"} className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
      </div>
    </div>
  );
}
