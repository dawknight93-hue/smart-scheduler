import { useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { addMemory, deleteMemory, loadMemory, updateMemory, type MemoryNote, type MemoryScope } from "@/lib/briefingMemory";

const SOURCE_LABEL: Record<MemoryNote["source"], string> = { feedback: "From feedback", manual: "Added", seed: "Starter" };

/**
 * The summary's memory: every active note is sent with each summary request,
 * so the writer follows your corrections from then on.
 */
export function BriefingMemoryEditor({ onClose, scope = "briefing" }: { onClose: (changed: boolean) => void; scope?: MemoryScope }) {
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [newNote, setNewNote] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadMemory(scope).then((n) => {
      setNotes(n);
      setLoading(false);
    });
  }, [scope]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setChanged(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  const active = notes.filter((n) => n.active).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-6" onClick={() => onClose(changed)}>
      <div className="w-full max-w-2xl max-h-[92dvh] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-4 sm:p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">{scope === "planner" ? "Planner memory" : "Summary memory"}</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {active} active note{active === 1 ? "" : "s"}.{" "}
              {scope === "planner"
                ? "Every active note goes to the goal coach and planner (plans, measures, daily focus), so they follow your corrections from then on."
                : "Every active note goes along with each summary, so the writer follows your corrections from then on."}{" "}
              Turn one off to test without it.
            </p>
          </div>
          <button onClick={() => onClose(changed)} className="ml-auto p-1.5 rounded-lg hover:bg-slate-800" aria-label="Close">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        {error && <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
        ) : (
          <ul className="space-y-2 mb-4">
            {notes.map((n) => (
              <li key={n.id} className={`rounded-lg border px-3 py-2 ${n.active ? "border-slate-700 bg-slate-800/60" : "border-slate-800 bg-slate-900 opacity-60"}`}>
                {editing === n.id ? (
                  <div className="space-y-2">
                    <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} className="w-full rounded-lg bg-slate-950 border border-slate-700 px-2 py-1.5 text-sm text-slate-100" />
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => setEditing(null)} className="px-3 py-1 rounded-lg text-xs text-slate-300 hover:bg-slate-700">Cancel</button>
                      <button
                        disabled={busy || !draft.trim()}
                        onClick={() =>
                          run(async () => {
                            await updateMemory(n.id, { note: draft.trim() });
                            setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, note: draft.trim() } : x)));
                            setEditing(null);
                          })
                        }
                        className="px-3 py-1 rounded-lg bg-blue-600 text-xs text-white disabled:opacity-50"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <label className="mt-0.5 flex items-center" title={n.active ? "Active — sent with every summary" : "Off"}>
                      <input
                        type="checkbox"
                        checked={n.active}
                        disabled={busy}
                        onChange={() =>
                          run(async () => {
                            await updateMemory(n.id, { active: !n.active });
                            setNotes((ns) => ns.map((x) => (x.id === n.id ? { ...x, active: !n.active } : x)));
                          })
                        }
                        className="accent-blue-500"
                      />
                    </label>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-200 break-words">{n.note}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        {SOURCE_LABEL[n.source]}
                        {n.kind ? ` · ${n.kind} briefing` : ""} · {new Date(n.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </p>
                      {n.excerpt && <p className="text-[11px] text-slate-500 mt-0.5 italic line-clamp-2">On: “{n.excerpt}”</p>}
                    </div>
                    <button onClick={() => { setEditing(n.id); setDraft(n.note); setConfirm(null); }} className="p-1 rounded hover:bg-slate-700" aria-label="Edit note">
                      <Pencil className="w-3.5 h-3.5 text-slate-400" />
                    </button>
                    {confirm === n.id ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await deleteMemory(n.id);
                            setNotes((ns) => ns.filter((x) => x.id !== n.id));
                            setConfirm(null);
                          })
                        }
                        className="px-2 py-0.5 rounded bg-rose-600 text-[11px] text-white"
                      >
                        Delete
                      </button>
                    ) : (
                      <button onClick={() => setConfirm(n.id)} className="p-1 rounded hover:bg-slate-700" aria-label="Delete note">
                        <Trash2 className="w-3.5 h-3.5 text-slate-400" />
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
            {!notes.length && <li className="text-sm text-slate-400">No notes yet.</li>}
          </ul>
        )}

        <div className="flex gap-2">
          <input
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder={scope === "planner" ? "Add a standing correction, e.g. “Keep weekday task blocks before 11:00.”" : "Add a standing correction, e.g. “Mention my UTA weekends a week ahead.”"}
            className="flex-1 min-w-0 rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newNote.trim()) (e.currentTarget.nextElementSibling as HTMLButtonElement | null)?.click();
            }}
          />
          <button
            disabled={busy || !newNote.trim()}
            onClick={() =>
              run(async () => {
                const n = await addMemory(newNote, "manual", undefined, undefined, scope);
                setNotes((ns) => [...ns, n]);
                setNewNote("");
              })
            }
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 text-xs text-white disabled:opacity-50"
          >
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
      </div>
    </div>
  );
}
