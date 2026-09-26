import { useEffect, useState } from "react";
import { CheckCircle2, Flag, Loader2, RotateCcw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { completeGoal, reopenGoal } from "@/lib/goalCompletion";

const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

/**
 * Finish line for a goal: "Mark goal complete" on an active goal, and the
 * completed banner (with Reopen) afterwards.
 */
export function GoalCompletionBar({ goalId, status, onChanged }: { goalId: string; status: string; onChanged: (status: string) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<{ completed_at: string | null; outcome_note: string | null } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "complete") return;
    void supabase
      .from("goals")
      .select("completed_at, outcome_note")
      .eq("id", goalId)
      .maybeSingle()
      .then(({ data }) => setInfo((data as { completed_at: string | null; outcome_note: string | null }) ?? null));
  }, [goalId, status]);

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const r = await completeGoal(goalId, note);
      setDone(r.sessionsRemoved ? `${r.sessionsRemoved} upcoming session${r.sessionsRemoved === 1 ? "" : "s"} removed from your calendar.` : "Nothing left on the calendar for it.");
      setOpen(false);
      onChanged("complete");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  async function reopen() {
    setBusy(true);
    setError(null);
    try {
      await reopenGoal(goalId);
      setDone(null);
      onChanged("active");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  if (status === "complete") {
    return (
      <div className="mt-4 rounded-xl border border-emerald-600/40 bg-emerald-600/10 p-4">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-emerald-300">Goal complete{info?.completed_at ? ` · ${fmtDay(info.completed_at)}` : ""}</p>
            {info?.outcome_note && <p className="text-sm text-slate-200 mt-0.5">{info.outcome_note}</p>}
            {done && <p className="text-xs text-slate-400 mt-0.5">{done}</p>}
            <p className="text-xs text-slate-400 mt-1">It's no longer planned in the Weekly Review, Briefing or reminders. Its measures and logged numbers are kept below.</p>
          </div>
          <button onClick={() => void reopen()} disabled={busy} className="flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />} Reopen
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
      </div>
    );
  }

  if (status !== "active" && status !== "missed") return null;

  return (
    <div className="mt-4">
      {!open ? (
        <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-emerald-600/40 bg-emerald-600/10 px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-600/20">
          <Flag className="w-4 h-4" /> Mark goal complete
        </button>
      ) : (
        <div className="rounded-xl border border-emerald-600/40 bg-slate-900/60 p-4 space-y-2">
          <p className="text-sm font-semibold text-slate-100">Mark this goal complete?</p>
          <p className="text-xs text-slate-400">Its upcoming 🎯 sessions come off your calendar and it stops appearing in the Weekly Review, Briefing and reminders. You can reopen it later.</p>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="How did it end? (optional) e.g. Hit 189.6 lb on Nov 20"
            className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
          />
          {error && <p className="text-xs text-rose-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={() => setOpen(false)} className="px-3 py-1.5 rounded-lg text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
            <button onClick={() => void finish()} disabled={busy} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-sm text-white hover:bg-emerald-500 disabled:opacity-50">
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Mark complete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
