import { useState } from "react";
import { ArrowLeft, CalendarCheck, Lock, Loader2, MoveHorizontal, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { DateField } from "@/components/DateTimeField";
import { PILLARS, PILLAR_COLORS, PILLAR_LABELS, type LifePillar } from "@/lib/types";
import type { DraftTask, Effort, PlanDraft } from "@/lib/planDay";

export interface PlanSpot {
  start: Date;
  end: Date;
  reason?: string;
}

const TIERS = [1, 2, 3, 4];
const TIER_STYLE: Record<number, string> = {
  1: "bg-rose-500 text-white",
  2: "bg-amber-400 text-slate-900",
  3: "bg-blue-500 text-white",
  4: "bg-slate-500 text-white",
};
const LENGTHS = [5, 10, 15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240];
const EFFORTS: { v: Effort; label: string }[] = [
  { v: "focus", label: "Focus" },
  { v: "routine", label: "Routine" },
  { v: "light", label: "Light" },
];

function span(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/**
 * The Plan a day panel: in the sidebar on wider screens, full screen on a phone.
 * The calendar beside it shows the preview as dashed "proposed" blocks.
 */
export function PlanDayPanel({
  draft,
  onChange,
  spots,
  reading,
  error,
  onRead,
  onLockIn,
  locking,
  onClose,
  onShowCalendar,
  compact,
}: {
  draft: PlanDraft;
  onChange: (d: PlanDraft) => void;
  /** Where the preview put each draft task (by key); missing = didn't fit. */
  spots: Map<string, PlanSpot>;
  reading: boolean;
  error: string | null;
  onRead: () => void;
  onLockIn: () => void;
  locking: boolean;
  onClose: () => void;
  /** Phone: hide the panel to look at the calendar. */
  onShowCalendar?: () => void;
  compact?: boolean;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  const set = (patch: Partial<PlanDraft>) => onChange({ ...draft, ...patch });
  const setTask = (key: string, patch: Partial<DraftTask>) =>
    set({ tasks: draft.tasks.map((t) => (t.key === key ? { ...t, ...patch } : t)) });

  const placedTasks = draft.tasks.filter((t) => spots.has(t.key));
  const overflow = draft.tasks.filter((t) => !spots.has(t.key));
  const plannedMin = placedTasks.reduce((n, t) => n + t.duration_min, 0);
  const ordered = [...placedTasks].sort((a, b) => spots.get(a.key)!.start.getTime() - spots.get(b.key)!.start.getTime());
  const field = "rounded-md border border-slate-700 bg-slate-950 px-1.5 py-1 text-xs text-slate-200";

  const card = (t: DraftTask) => {
    const spot = spots.get(t.key);
    return (
      <div key={t.key} className={`rounded-lg border p-2.5 ${spot ? "border-slate-700 bg-slate-950/60" : "border-amber-500/30 bg-amber-500/5"}`}>
        <div className="flex items-start gap-2">
          <span className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${t.pillar ? PILLAR_COLORS[t.pillar].dot : "bg-slate-600"}`} />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm font-medium text-slate-100 outline-none focus:underline"
            value={t.name}
            onChange={(e) => setTask(t.key, { name: e.target.value })}
            aria-label="Task name"
          />
          <button
            onClick={() => set({ tasks: draft.tasks.filter((x) => x.key !== t.key) })}
            className="text-slate-500 hover:text-rose-400"
            aria-label={`Remove ${t.name}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-1.5 pl-[18px] text-[11px]">
          {spot ? (
            <span className="text-blue-300 tabular-nums">
              {hhmm(spot.start)}–{hhmm(new Date(spot.start.getTime() + t.duration_min * 60000))}
              {t.pin ? " · placed by you" : spot.reason ? ` · ${spot.reason}` : ""}
            </span>
          ) : (
            <span className="text-amber-300">Won't fit this day → goes to your list</span>
          )}
          {t.note && <div className="text-slate-500">{t.note}</div>}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[18px]">
          <div className="flex overflow-hidden rounded-md border border-slate-700">
            {TIERS.map((n) => (
              <button
                key={n}
                onClick={() => setTask(t.key, { tier: n, pin: null })}
                className={`px-1.5 py-0.5 text-[11px] font-semibold ${t.tier === n ? TIER_STYLE[n] : "text-slate-400 hover:bg-slate-800"}`}
                title={`Priority P${n}`}
              >
                P{n}
              </button>
            ))}
          </div>
          <select className={field} value={t.duration_min} onChange={(e) => setTask(t.key, { duration_min: Number(e.target.value) })} aria-label="Length">
            {[...new Set([...LENGTHS, t.duration_min])].sort((a, b) => a - b).map((m) => (
              <option key={m} value={m}>{span(m)}</option>
            ))}
          </select>
          <select className={field} value={t.effort} onChange={(e) => setTask(t.key, { effort: e.target.value as Effort, pin: null })} aria-label="Energy">
            {EFFORTS.map((x) => (
              <option key={x.v} value={x.v}>{x.label}</option>
            ))}
          </select>
          <select
            className={`${field} max-w-[7.5rem]`}
            value={t.pillar ?? ""}
            onChange={(e) => setTask(t.key, { pillar: (e.target.value || null) as LifePillar | null })}
            aria-label="Role"
          >
            <option value="">No role</option>
            {PILLARS.map((p) => (
              <option key={p} value={p}>{PILLAR_LABELS[p]}</option>
            ))}
          </select>
          {spot && (
            <button
              onClick={() => setTask(t.key, { flexible: !t.flexible })}
              className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${t.flexible ? "border-slate-600 text-slate-300" : "border-blue-500/50 text-blue-300"}`}
              title={t.flexible ? "The planner may move it during the day" : "Stays at this time once locked in"}
            >
              {t.flexible ? <MoveHorizontal className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              {t.flexible ? "Planner may move" : "Lock time"}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={`flex flex-col gap-3 ${compact ? "" : "rounded-xl border border-blue-500/30 bg-slate-900 p-3"}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarCheck className="h-4 w-4 text-blue-400" />
          <h2 className="text-sm font-semibold text-slate-100">Plan a day</h2>
        </div>
        <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-800" aria-label="Close Plan a day">
          <X className="h-4 w-4" />
        </button>
      </div>

      <DateField value={draft.day} onChange={(day) => set({ day, tasks: draft.tasks.map((t) => ({ ...t, pin: null })) })} />

      {draft.stage === "input" ? (
        <>
          <textarea
            className="input min-h-[180px] resize-y text-sm leading-relaxed"
            placeholder={"Type or paste anything, one per line:\ncall the VA, urgent\nfinish the bid\nstudy systems for an hour\noil change if there's time"}
            value={draft.text}
            onChange={(e) => set({ text: e.target.value })}
          />
          <p className="text-[11px] text-slate-500">
            No format needed. Words like "urgent", "if there's time" or "maybe" set the priority; mention a length if you know it.
          </p>
          {error && <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">{error}</div>}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onRead}
              disabled={reading || !draft.text.trim()}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {reading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {reading ? "Reading your list…" : "Read with AI & plan"}
            </button>
            {draft.tasks.length > 0 && (
              <button onClick={() => set({ stage: "preview" })} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">
                Back to plan
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="rounded-lg bg-slate-800/60 px-2.5 py-2 text-xs text-slate-300">
            <span className="font-semibold text-slate-100">{placedTasks.length} planned</span> · {span(plannedMin)}
            {overflow.length > 0 && <span className="text-amber-300"> · {overflow.length} won't fit</span>}
            <div className="mt-0.5 text-[11px] text-slate-500">
              Dashed blocks on the calendar are the preview. Drag them to adjust; nothing is saved until you lock it in.
            </div>
          </div>

          <div className="flex flex-col gap-2">{ordered.map(card)}</div>

          {overflow.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-[11px] font-medium uppercase tracking-wide text-amber-300/80">Won't fit · goes to your list</div>
              {overflow.map(card)}
            </div>
          )}

          {error && <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">{error}</div>}

          <div className="sticky bottom-0 -mx-1 flex flex-col gap-2 bg-slate-900/95 px-1 pt-2 pb-1 backdrop-blur">
            <button
              onClick={onLockIn}
              disabled={locking || draft.tasks.length === 0}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {locking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
              Lock in & add to calendar
            </button>
            <div className="flex gap-2">
              <button
                onClick={() => set({ stage: "input" })}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Edit list
              </button>
              <button
                onClick={() => set({ tasks: draft.tasks.map((t) => ({ ...t, pin: null })) })}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                title="Forget where you dragged things and let the planner lay it out again"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Re-plan
              </button>
              {onShowCalendar && (
                <button onClick={onShowCalendar} className="flex flex-1 items-center justify-center rounded-lg border border-slate-700 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
                  See calendar
                </button>
              )}
            </div>
            {confirmClear ? (
              <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
                Start over with an empty list?
                <span className="flex gap-2">
                  <button onClick={() => { onChange({ day: draft.day, text: "", tasks: [], stage: "input" }); setConfirmClear(false); }} className="text-rose-300">Clear</button>
                  <button onClick={() => setConfirmClear(false)}>Keep</button>
                </span>
              </div>
            ) : (
              <button onClick={() => setConfirmClear(true)} className="text-[11px] text-slate-500 hover:text-slate-300">
                Start over
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
