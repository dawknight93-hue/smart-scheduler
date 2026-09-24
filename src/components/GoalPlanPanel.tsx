import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { ContextTag } from "@/lib/types";
import {
  PLAN_GOAL_COLUMNS,
  setMilestoneDone,
  type Milestone,
  type MilestoneLevel,
  type PlanGoal,
  type PlanMode,
  type PreferredTime,
} from "@/lib/goalPlanning";

const RESEARCH_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/goal-research`;
const HEADERS = {
  Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};

const LEVEL_LABEL: Record<MilestoneLevel, string> = { year: "Yearly", quarter: "Quarterly", month: "Monthly", week: "Weekly" };
const CONTEXTS: ContextTag[] = ["desk", "home", "phone", "errand", "other"];
const TIMES: { v: PreferredTime; l: string }[] = [
  { v: "any", l: "Any time" },
  { v: "morning", l: "Morning (06–12)" },
  { v: "afternoon", l: "Afternoon (12–17)" },
  { v: "evening", l: "Evening (17–22)" },
];

interface CalendarOption {
  calendar_id: string;
  name: string;
}

/**
 * Cascade for one active goal: generate milestones + weekly target, and choose
 * how the weekly target reaches the calendar (scheduled by the app, or counted
 * from a calendar that already carries the sessions, like Runna).
 */
export function GoalPlanPanel({ goalId }: { goalId: string }) {
  const [goal, setGoal] = useState<PlanGoal | null>(null);
  const [calendars, setCalendars] = useState<CalendarOption[]>([]);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [g, c] = await Promise.all([
        supabase.from("goals").select(PLAN_GOAL_COLUMNS).eq("id", goalId).maybeSingle(),
        supabase.from("calendar_connections").select("calendar_id, name, role, enabled"),
      ]);
      if (g.data) setGoal(g.data as PlanGoal);
      const seen = new Set<string>();
      setCalendars(
        ((c.data as (CalendarOption & { role: string; enabled: boolean })[]) ?? [])
          .filter((x) => x.enabled && x.role !== "schedule_target" && !seen.has(x.calendar_id) && seen.add(x.calendar_id))
      );
    })();
  }, [goalId]);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(RESEARCH_URL, { method: "POST", headers: HEADERS, body: JSON.stringify({ action: "cascade", goal_id: goalId }) });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
      const { data: fresh } = await supabase.from("goals").select(PLAN_GOAL_COLUMNS).eq("id", goalId).maybeSingle();
      if (fresh) setGoal(fresh as PlanGoal);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't generate the plan");
    } finally {
      setGenerating(false);
    }
  }

  async function save() {
    if (!goal) return;
    setSaving(true);
    setError(null);
    const { error: e } = await supabase
      .from("goals")
      .update({
        plan_mode: goal.plan_mode,
        cadence_sessions_per_week: goal.cadence_sessions_per_week,
        weekly_target: goal.weekly_target,
        session_minutes: goal.session_minutes,
        session_context: goal.session_context,
        preferred_time: goal.preferred_time,
        count_calendar_id: goal.count_calendar_id,
        count_keyword: goal.count_keyword?.trim() || null,
      })
      .eq("id", goal.id);
    setSaving(false);
    if (e) setError(e.message);
    else {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }

  async function toggle(m: Milestone) {
    if (!goal) return;
    const next = await setMilestoneDone(goal, m.id, !m.done);
    setGoal({ ...goal, milestones: next });
  }

  if (!goal) return null;
  const set = (patch: Partial<PlanGoal>) => setGoal({ ...goal, ...patch });
  const hasPlan = !!goal.cascade_generated_at;
  const milestones = goal.milestones ?? [];

  return (
    <div className="mt-4 rounded-xl border border-slate-700 bg-slate-900/60 p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Plan</h2>
          <p className="text-xs text-slate-400">
            {hasPlan ? "Checkpoints stay in the app; only the weekly sessions reach your calendar." : "Break this goal into checkpoints and a weekly target."}
          </p>
        </div>
        <button
          onClick={generate}
          disabled={generating}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap"
        >
          {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {hasPlan ? "Regenerate" : "Generate plan"}
        </button>
      </div>

      {error && <p className="text-sm text-rose-300 mb-2">{error}</p>}

      {hasPlan && (
        <>
          {goal.deadline && (
            <p className="text-xs text-slate-400 mb-2">
              Deadline {new Date(goal.deadline).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
            </p>
          )}
          <div className="space-y-1 mb-4">
            {milestones.map((m) => (
              <label key={m.id} className="flex items-start gap-2 text-sm py-0.5 cursor-pointer">
                <input type="checkbox" checked={m.done} onChange={() => toggle(m)} className="mt-1 accent-blue-600" />
                <span className="w-16 shrink-0 text-[11px] uppercase tracking-wide text-slate-500 pt-0.5">{LEVEL_LABEL[m.level]}</span>
                <span className="w-14 shrink-0 tabular-nums text-xs text-slate-400 pt-0.5">{m.due.slice(5)}</span>
                <span className={m.done ? "text-slate-500 line-through" : "text-slate-200"}>{m.title}</span>
              </label>
            ))}
          </div>

          <div className="border-t border-slate-800 pt-3 space-y-3">
            <div>
              <div className="text-xs font-medium text-slate-400 mb-1.5">How this week's sessions reach the calendar</div>
              <div className="grid grid-cols-2 gap-2">
                {(["schedule", "count"] as PlanMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => set({ plan_mode: mode })}
                    className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                      goal.plan_mode === mode ? "border-blue-500 bg-blue-500/10 text-blue-200" : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-600"
                    }`}
                  >
                    <div className="font-semibold">{mode === "schedule" ? "App schedules them" : "Count from a calendar"}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {mode === "schedule" ? "Finds free time for each session." : "Sessions already arrive (e.g. Runna)."}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-400">
                Session name
                <input className="input mt-1" value={goal.weekly_target ?? ""} onChange={(e) => set({ weekly_target: e.target.value })} />
              </label>
              <label className="text-xs text-slate-400">
                Sessions per week
                <input
                  className="input mt-1"
                  type="number"
                  min={1}
                  max={14}
                  value={goal.cadence_sessions_per_week ?? ""}
                  onChange={(e) => set({ cadence_sessions_per_week: e.target.value ? Number(e.target.value) : null })}
                />
              </label>
            </div>

            {goal.plan_mode === "count" ? (
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-slate-400">
                  Calendar to count
                  <select className="input mt-1" value={goal.count_calendar_id ?? ""} onChange={(e) => set({ count_calendar_id: e.target.value || null })}>
                    <option value="">Choose…</option>
                    {calendars.map((c) => (
                      <option key={c.calendar_id} value={c.calendar_id}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-slate-400">
                  Only titles containing (optional)
                  <input className="input mt-1" placeholder="e.g. Run" value={goal.count_keyword ?? ""} onChange={(e) => set({ count_keyword: e.target.value })} />
                </label>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                <label className="text-xs text-slate-400">
                  Minutes
                  <input
                    className="input mt-1"
                    type="number"
                    min={10}
                    step={5}
                    value={goal.session_minutes ?? ""}
                    onChange={(e) => set({ session_minutes: e.target.value ? Number(e.target.value) : null })}
                  />
                </label>
                <label className="text-xs text-slate-400">
                  Context
                  <select className="input mt-1" value={goal.session_context ?? "other"} onChange={(e) => set({ session_context: e.target.value as ContextTag })}>
                    {CONTEXTS.map((c) => (
                      <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-slate-400">
                  Time of day
                  <select className="input mt-1" value={goal.preferred_time} onChange={(e) => set({ preferred_time: e.target.value as PreferredTime })}>
                    {TIMES.map((t) => (
                      <option key={t.v} value={t.v}>{t.l}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            <div className="flex items-center justify-end gap-3">
              {saved && <span className="text-xs text-emerald-300">Saved</span>}
              <button onClick={save} disabled={saving} className="px-4 py-2 rounded-lg bg-slate-800 text-slate-200 text-sm hover:bg-slate-700 disabled:opacity-50">
                {saving ? "Saving…" : "Save plan settings"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
