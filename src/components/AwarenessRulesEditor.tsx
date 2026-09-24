import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, DollarSign, Heart, Info, Loader2, Plane, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { previewTemplate, type AwarenessRule, type NoteTone } from "@/lib/awareness";
import { deleteRule, loadAwarenessRules, resetRules, saveRule, type NewRule } from "@/lib/awarenessRules";

const TONES: { id: NoteTone; label: string; icon: React.ReactNode }[] = [
  { id: "duty", label: "Duty", icon: <Plane className="w-3.5 h-3.5" /> },
  { id: "money", label: "Money", icon: <DollarSign className="w-3.5 h-3.5" /> },
  { id: "family", label: "Family", icon: <Heart className="w-3.5 h-3.5" /> },
  { id: "info", label: "Info", icon: <Info className="w-3.5 h-3.5" /> },
];

const ROLE_HELP: Record<string, string> = {
  reserve: "Reserve rule — works with the Proffer and Assignments rules. Extra blanks: {flying}, {proffer}, {lookout}, {confirm_by}.",
  proffer: "Proffer rule — its times feed {proffer} in the reserve rule. Its own note shows when tomorrow isn't a reserve day.",
  assignments: "Assignments rule — its start time feeds {lookout} in the reserve rule.",
};

function blankRule(position: number, seed?: { title: string; source?: string }): NewRule {
  const words = (seed?.title ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2).slice(0, 2).join(" ");
  return {
    position,
    enabled: true,
    label: seed?.title ? seed.title.replace(/^[\s,]+/, "").slice(0, 40) : "New rule",
    match: words,
    source: null,
    tone: "info",
    role: null,
    note: "{title}{when}.",
    action: null,
    note_next: null,
    action_next: null,
    lead_days: 0,
    coming_up: null,
    confirm_by: null,
    assign_from: null,
  };
}

/** Edit the rules that turn info-only calendar events into Situational awareness notes. */
export function AwarenessRulesEditor({ onClose, draft }: { onClose: (changed: boolean) => void; draft?: { title: string; source?: string } | null }) {
  const [rules, setRules] = useState<AwarenessRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<(AwarenessRule | (NewRule & { id?: string })) | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);

  useEffect(() => {
    void loadAwarenessRules(true).then((r) => {
      setRules(r);
      setLoading(false);
      if (draft) {
        const nr = blankRule((r[r.length - 1]?.position ?? 0) + 10, draft);
        setEdit(nr);
        setOpen("new");
      }
    });
  }, [draft]);

  function startEdit(r: AwarenessRule) {
    if (open === r.id) {
      setOpen(null);
      setEdit(null);
      return;
    }
    setOpen(r.id);
    setEdit({ ...r });
    setConfirm(null);
  }

  async function save() {
    if (!edit) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveRule(edit);
      setRules((rs) => (rs.some((x) => x.id === saved.id) ? rs.map((x) => (x.id === saved.id ? saved : x)) : [...rs, saved]).sort((a, b) => a.position - b.position));
      setChanged(true);
      setOpen(null);
      setEdit(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (confirm !== id) return setConfirm(id);
    try {
      await deleteRule(id);
      setRules((rs) => rs.filter((r) => r.id !== id));
      setChanged(true);
      setOpen(null);
      setEdit(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete");
    }
  }

  async function move(r: AwarenessRule, dir: -1 | 1) {
    const idx = rules.findIndex((x) => x.id === r.id);
    const other = rules[idx + dir];
    if (!other) return;
    try {
      const [a, b] = await Promise.all([saveRule({ ...r, position: other.position }), saveRule({ ...other, position: r.position })]);
      setRules((rs) => rs.map((x) => (x.id === a.id ? a : x.id === b.id ? b : x)).sort((p, q) => p.position - q.position));
      setChanged(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reorder");
    }
  }

  async function toggle(r: AwarenessRule) {
    try {
      const saved = await saveRule({ ...r, enabled: !r.enabled });
      setRules((rs) => rs.map((x) => (x.id === saved.id ? saved : x)));
      setChanged(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    }
  }

  async function reset() {
    if (confirm !== "reset") return setConfirm("reset");
    setLoading(true);
    try {
      setRules(await resetRules());
      setChanged(true);
      setConfirm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't reset");
    } finally {
      setLoading(false);
    }
  }

  const set = <K extends keyof NewRule>(k: K, v: NewRule[K]) => setEdit((e) => (e ? { ...e, [k]: v } : e));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-6" onClick={() => onClose(changed)}>
      <div className="w-full max-w-2xl max-h-[92dvh] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-4 sm:p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-100">Awareness rules</h2>
          <button onClick={() => onClose(changed)} className="ml-auto p-1 rounded hover:bg-slate-800" aria-label="Close">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>
        <p className="mb-4 text-xs text-slate-400">
          How the Briefing reads your info-only calendars (Informational, Jatara's). Each rule matches words in an event's title and says what to tell you on the day,
          the day before, and in Coming up. The first matching rule wins. Changes show the next time the Briefing loads.
        </p>

        {error && <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Loading rules…</div>
        ) : (
          <ul className="space-y-2">
            {rules.map((r, i) => (
              <li key={r.id} className={`rounded-xl border ${open === r.id ? "border-blue-500/40" : "border-slate-800"} bg-slate-900/60`}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <button onClick={() => startEdit(r)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    {open === r.id ? <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />}
                    <span className="text-slate-400 shrink-0">{TONES.find((t) => t.id === r.tone)?.icon}</span>
                    <span className={`truncate text-sm font-medium ${r.enabled ? "text-slate-100" : "text-slate-500 line-through"}`}>{r.label}</span>
                    <span className="truncate text-xs text-slate-500">
                      {r.match ? `“${r.match}”` : "any title"}
                      {r.source ? ` · ${r.source} calendar` : ""}
                    </span>
                  </button>
                  <button onClick={() => move(r, -1)} disabled={i === 0} className="p-1 rounded text-slate-500 hover:bg-slate-800 disabled:opacity-30" aria-label="Move up"><ArrowUp className="w-3.5 h-3.5" /></button>
                  <button onClick={() => move(r, 1)} disabled={i === rules.length - 1} className="p-1 rounded text-slate-500 hover:bg-slate-800 disabled:opacity-30" aria-label="Move down"><ArrowDown className="w-3.5 h-3.5" /></button>
                  <label className="flex items-center gap-1 text-[11px] text-slate-400">
                    <input type="checkbox" checked={r.enabled} onChange={() => toggle(r)} className="accent-blue-600" />
                    On
                  </label>
                </div>
                {open === r.id && edit && <RuleForm rule={edit} set={set} onSave={save} saving={saving} onDelete={() => remove(r.id)} confirmDelete={confirm === r.id} />}
              </li>
            ))}
            {open === "new" && edit && (
              <li className="rounded-xl border border-blue-500/40 bg-slate-900/60">
                <div className="px-3 pt-2 text-sm font-medium text-slate-100">New rule</div>
                <RuleForm rule={edit} set={set} onSave={save} saving={saving} />
              </li>
            )}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            onClick={() => {
              setEdit(blankRule((rules[rules.length - 1]?.position ?? 0) + 10));
              setOpen("new");
            }}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
          >
            <Plus className="w-4 h-4" /> Add rule
          </button>
          <button onClick={reset} className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-800">
            <RotateCcw className="w-3.5 h-3.5" /> {confirm === "reset" ? "Tap again to restore the original rules" : "Restore defaults"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RuleForm({
  rule,
  set,
  onSave,
  saving,
  onDelete,
  confirmDelete,
}: {
  rule: NewRule & { id?: string };
  set: <K extends keyof NewRule>(k: K, v: NewRule[K]) => void;
  onSave: () => void;
  saving: boolean;
  onDelete?: () => void;
  confirmDelete?: boolean;
}) {
  const field = "w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none";
  const label = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500";
  const Preview = ({ tpl }: { tpl: string | null }) =>
    tpl ? <div className="mt-1 text-[11px] text-slate-500">Preview: <span className="text-slate-300">{previewTemplate(tpl, rule.role)}</span></div> : null;

  return (
    <div className="space-y-3 border-t border-slate-800 px-3 py-3">
      {rule.role && <p className="rounded-lg bg-slate-800/70 px-2.5 py-2 text-[11px] text-slate-400">{ROLE_HELP[rule.role]}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <span className={label}>Name</span>
          <input className={field} value={rule.label} onChange={(e) => set("label", e.target.value)} />
        </div>
        <div>
          <span className={label}>Title contains (comma-separated)</span>
          <input className={field} value={rule.match} placeholder="e.g. bid window, bidding" onChange={(e) => set("match", e.target.value)} />
        </div>
        <div>
          <span className={label}>Only from calendar (optional)</span>
          <input className={field} value={rule.source ?? ""} placeholder="e.g. jatara" onChange={(e) => set("source", e.target.value.trim() || null)} />
        </div>
        <div>
          <span className={label}>Category</span>
          <div className="flex flex-wrap gap-1.5">
            {TONES.map((t) => (
              <button
                key={t.id}
                onClick={() => set("tone", t.id)}
                className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${rule.tone === t.id ? "border-transparent bg-slate-200 text-slate-900" : "border-slate-700 bg-slate-800 text-slate-400"}`}
              >
                {t.icon} {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <span className={label}>On the day — note</span>
        <input className={field} value={rule.note} onChange={(e) => set("note", e.target.value)} />
        <Preview tpl={rule.note} />
      </div>
      <div>
        <span className={label}>On the day — action (optional)</span>
        <input className={field} value={rule.action ?? ""} onChange={(e) => set("action", e.target.value || null)} />
        <Preview tpl={rule.action} />
      </div>
      <div>
        <span className={label}>{rule.role === "reserve" ? "Day before a reserve day — note" : "Day before — note (optional)"}</span>
        <input className={field} value={rule.note_next ?? ""} onChange={(e) => set("note_next", e.target.value || null)} />
        <Preview tpl={rule.note_next} />
      </div>
      <div>
        <span className={label}>{rule.role === "reserve" ? "Day before a reserve day — action" : "Day before — action (optional)"}</span>
        <textarea className={`${field} min-h-[60px]`} value={rule.action_next ?? ""} onChange={(e) => set("action_next", e.target.value || null)} />
        <Preview tpl={rule.action_next} />
      </div>
      <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
        <div>
          <span className={label}>Coming up (days ahead)</span>
          <input type="number" min={0} max={14} className={field} value={rule.lead_days} onChange={(e) => set("lead_days", Math.max(0, Math.min(14, Number(e.target.value) || 0)))} />
        </div>
        <div>
          <span className={label}>Coming up — wording</span>
          <input className={field} value={rule.coming_up ?? ""} placeholder="e.g. Payday {date}" onChange={(e) => set("coming_up", e.target.value || null)} />
          <Preview tpl={rule.coming_up} />
        </div>
      </div>
      {rule.role === "reserve" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <span className={label}>Confirm assignment by</span>
            <input className={field} value={rule.confirm_by ?? ""} placeholder="20:00" onChange={(e) => set("confirm_by", e.target.value || null)} />
          </div>
          <div>
            <span className={label}>Assignments posted from (if not on calendar)</span>
            <input className={field} value={rule.assign_from ?? ""} placeholder="15:00" onChange={(e) => set("assign_from", e.target.value || null)} />
          </div>
        </div>
      )}
      <p className="text-[11px] text-slate-500">
        Blanks you can use: {"{title} {start} {end} {when} {time} {at_time} {date} {tomorrow} {through}"}
        {rule.role === "reserve" ? " {flying} {proffer} {lookout} {confirm_by}" : ""}
      </p>
      <div className="flex items-center gap-2">
        <button onClick={onSave} disabled={saving || !rule.label.trim()} className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50">
          {saving ? "Saving…" : "Save rule"}
        </button>
        {onDelete && !rule.role && (
          <button onClick={onDelete} className="ml-auto flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10">
            <Trash2 className="w-3.5 h-3.5" /> {confirmDelete ? "Tap again to delete" : "Delete"}
          </button>
        )}
      </div>
    </div>
  );
}
