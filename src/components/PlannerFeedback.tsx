import { useState } from "react";
import { Loader2, ThumbsDown } from "lucide-react";
import { addMemory } from "@/lib/briefingMemory";

/**
 * "Correct the planner": a short note saved to Planner memory, which goes to
 * the goal coach and planner with every request from then on.
 */
export function PlannerFeedback({ kind, excerpt, label = "Correct the planner" }: { kind: string; excerpt?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addMemory(note, "feedback", kind, excerpt, "planner");
      setSaved(true);
      setOpen(false);
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  if (saved && !open)
    return (
      <span className="text-[11px] text-emerald-400">
        Saved to Planner memory — used from the next plan or reply.{" "}
        <button onClick={() => { setSaved(false); setOpen(true); }} className="text-blue-400 hover:underline">Add another</button>
      </span>
    );

  return open ? (
    <div className="mt-2 space-y-2">
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="What should it do differently? e.g. “Never schedule task blocks on UTA weekends.”"
        className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
      />
      {error && <p className="text-xs text-rose-300">{error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={() => setOpen(false)} className="px-3 py-1 rounded-lg text-xs text-slate-300 hover:bg-slate-800">Cancel</button>
        <button onClick={() => void save()} disabled={busy || !note.trim()} className="flex items-center gap-1 px-3 py-1 rounded-lg bg-blue-600 text-xs text-white disabled:opacity-50">
          {busy && <Loader2 className="w-3 h-3 animate-spin" />} Save to Planner memory
        </button>
      </div>
    </div>
  ) : (
    <button onClick={() => setOpen(true)} className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-rose-300">
      <ThumbsDown className="w-3 h-3" /> {label}
    </button>
  );
}
