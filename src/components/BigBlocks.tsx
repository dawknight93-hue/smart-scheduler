import { useEffect, useState } from "react";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { blockKey, deleteLifeBlock, loadLifeBlocks, saveLifeBlock, type LifeBlock } from "@/lib/lifeBlocks";

/**
 * "Can this goal happen during …?" — one switch per big life block. Until you
 * answer, the goal may be scheduled during any block; the card asks once.
 */
export function GoalBlocksPanel({
  goalId,
  blocked,
  asked,
  onSaved,
}: {
  goalId: string;
  blocked: string[];
  asked: boolean;
  onSaved: (blocked: string[]) => void;
}) {
  const [blocks, setBlocks] = useState<LifeBlock[]>([]);
  const [draft, setDraft] = useState<Set<string>>(new Set(blocked));
  const [open, setOpen] = useState(!asked);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editBlocks, setEditBlocks] = useState(false);

  useEffect(() => {
    void loadLifeBlocks().then((b) => setBlocks(b.filter((x) => x.enabled)));
  }, [editBlocks]);
  useEffect(() => setDraft(new Set(blocked)), [blocked]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const list = blocks.map((b) => b.key).filter((k) => draft.has(k));
      const { error: e } = await supabase.from("goals").update({ blocked_blocks: list, blocks_asked: true }).eq("id", goalId);
      if (e) throw new Error(e.message);
      onSaved(list);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  const avoided = blocks.filter((b) => blocked.includes(b.key));

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
        <span className="font-medium text-slate-300">Big blocks:</span>
        {avoided.length ? <span>stays out of {avoided.map((b) => b.label).join(", ")}</span> : <span>can be scheduled during any of them</span>}
        <button onClick={() => setOpen(true)} className="text-blue-400 hover:underline">
          Change
        </button>
      </div>
    );
  }

  return (
    <div className={`rounded-lg border p-3 ${asked ? "border-slate-700 bg-slate-800/40" : "border-amber-500/40 bg-amber-500/5"}`}>
      <p className="text-sm font-medium text-slate-100">{asked ? "Big blocks" : "One question for this goal"}</p>
      <p className="text-xs text-slate-400 mt-0.5 mb-2">
        Can this goal's sessions be scheduled during these stretches of your life? Switch off the ones it should stay out of.
      </p>
      <div className="flex flex-wrap gap-2">
        {blocks.map((b) => {
          const allowed = !draft.has(b.key);
          return (
            <button
              key={b.key}
              onClick={() =>
                setDraft((d) => {
                  const n = new Set(d);
                  if (n.has(b.key)) n.delete(b.key);
                  else n.add(b.key);
                  return n;
                })
              }
              aria-pressed={allowed}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium ${
                allowed ? "border-emerald-600/50 bg-emerald-600/10 text-emerald-300" : "border-rose-500/40 bg-rose-500/10 text-rose-300 line-through decoration-rose-400/60"
              }`}
            >
              {allowed ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
              {b.label}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-slate-500 mt-2">Green = can happen then · red = keep it out. You can change this any time.</p>
      {error && <p className="text-xs text-rose-300 mt-1">{error}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button onClick={() => void save()} disabled={saving} className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500 disabled:opacity-50">
          {saving && <Loader2 className="w-3 h-3 animate-spin" />} Save
        </button>
        {asked && (
          <button onClick={() => setOpen(false)} className="rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
            Cancel
          </button>
        )}
        <button onClick={() => setEditBlocks(true)} className="ml-auto flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200">
          <Pencil className="w-3 h-3" /> Edit blocks & keywords
        </button>
      </div>
      {editBlocks && <LifeBlocksEditor onClose={() => setEditBlocks(false)} />}
    </div>
  );
}

/** The list of big life blocks and the title keywords that find them on your calendar. */
export function LifeBlocksEditor({ onClose }: { onClose: () => void }) {
  const [blocks, setBlocks] = useState<LifeBlock[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");

  useEffect(() => {
    void loadLifeBlocks().then(setBlocks);
  }, []);

  async function persist(b: LifeBlock) {
    setBusy(b.key);
    setError(null);
    try {
      const saved = await saveLifeBlock(b);
      setBlocks((list) => (list ?? []).map((x) => (x.key === b.key ? saved : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(null);
    }
  }

  async function add() {
    const label = newLabel.trim();
    if (!label) return;
    const b: LifeBlock = { key: blockKey(label), label, kind: "keywords", keywords: label.toLowerCase(), enabled: true, position: ((blocks ?? [])[(blocks ?? []).length - 1]?.position ?? 50) + 10 };
    setBusy("new");
    setError(null);
    try {
      const saved = await saveLifeBlock(b);
      setBlocks((list) => [...(list ?? []), saved]);
      setNewLabel("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusy(null);
    }
  }

  async function remove(b: LifeBlock) {
    setBusy(b.key);
    try {
      await deleteLifeBlock(b);
      setBlocks((list) => (list ?? []).filter((x) => x.key !== b.key));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete");
    } finally {
      setBusy(null);
    }
  }

  const field = "w-full rounded-lg bg-slate-950 border border-slate-700 px-2 py-1.5 text-sm text-slate-100";

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 sm:p-4" onClick={onClose}>
      <div
        className="w-full sm:max-w-lg max-h-[88dvh] overflow-y-auto rounded-t-3xl sm:rounded-2xl border border-slate-700 bg-slate-900 p-5 pb-[calc(20px+env(safe-area-inset-bottom))] sm:pb-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Big life blocks</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Found on your calendar by words in event titles (all-day or 8+ hour events). Flying is every flight leg plus layovers away from MIA.
            </p>
          </div>
          <button onClick={onClose} className="ml-auto p-1.5 rounded-lg hover:bg-slate-800" aria-label="Close">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>
        {error && <p className="mb-2 text-sm text-rose-300">{error}</p>}
        {!blocks ? (
          <p className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
        ) : (
          <ul className="space-y-2">
            {blocks.map((b) => (
              <li key={b.key} className={`rounded-lg border px-3 py-2.5 ${b.enabled ? "border-slate-700 bg-slate-800/60" : "border-slate-800 opacity-60"}`}>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={b.enabled}
                    onChange={() => void persist({ ...b, enabled: !b.enabled })}
                    className="accent-blue-500"
                    aria-label={`Use ${b.label}`}
                  />
                  <input
                    className="flex-1 min-w-0 bg-transparent text-sm font-medium text-slate-100 outline-none focus:underline"
                    value={b.label}
                    onChange={(e) => setBlocks((list) => (list ?? []).map((x) => (x.key === b.key ? { ...x, label: e.target.value } : x)))}
                    onBlur={() => void persist(b)}
                  />
                  {busy === b.key && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
                  {b.kind === "keywords" && b.id && (
                    <button onClick={() => void remove(b)} className="p-1 rounded hover:bg-slate-700" aria-label={`Delete ${b.label}`}>
                      <Trash2 className="w-3.5 h-3.5 text-slate-500" />
                    </button>
                  )}
                </div>
                {b.kind === "trips" ? (
                  <p className="mt-1 text-[11px] text-slate-500">Flight legs and time away from MIA between them (from your crew schedule).</p>
                ) : (
                  <label className="mt-1.5 block text-[11px] text-slate-400">
                    Title words (comma-separated)
                    <input
                      className={`${field} mt-1`}
                      value={b.keywords}
                      onChange={(e) => setBlocks((list) => (list ?? []).map((x) => (x.key === b.key ? { ...x, keywords: e.target.value } : x)))}
                      onBlur={() => void persist(b)}
                    />
                  </label>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex gap-2">
          <input className={field} placeholder="Add a block, e.g. Deployment" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
          <button onClick={() => void add()} disabled={!newLabel.trim() || busy === "new"} className="flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">
            <Plus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
      </div>
    </div>
  );
}
