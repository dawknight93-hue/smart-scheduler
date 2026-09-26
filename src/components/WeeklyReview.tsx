import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, ClipboardCheck, Loader2, X, Flag, Hourglass, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { addDays, getWeekStart } from "@/lib/schedulingEngine";
import { scheduleAutoPush } from "@/lib/gcalSync";
import { PILLAR_LABELS, getPillarColor } from "@/lib/types";
import {
  PLAN_GOAL_COLUMNS,
  approveGoalWeek,
  defaultReviewWeek,
  goalShortName,
  loadReviews,
  loadWeekData,
  milestonesDueSoon,
  planWeek,
  recordReview,
  reviewForPlan,
  setMilestoneDone,
  verifyWeek,
  type GoalWeekPlan,
  type PlanGoal,
  type ProposedSession,
  type VerifyResult,
  type WeekReviewRow,
} from "@/lib/goalPlanning";
import { goalDayEntries, loadDailyItems, setCountedDone, setSessionDone, writeDailyPlan, type DailyItem, type DayEntry } from "@/lib/goalDaily";
import { effortGoals, loadEntries, loadMeasures, planKey, type GoalMeasure, type MeasureEntry } from "@/lib/measures";
import { OutcomeTracker } from "@/components/MeasureWidgets";
import { completeGoal } from "@/lib/goalCompletion";

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const dayLabel = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

export function WeeklyReview({ onOpenGoals }: { onOpenGoals: () => void }) {
  const [weekStart, setWeekStart] = useState(() => defaultReviewWeek());
  const [goals, setGoals] = useState<PlanGoal[]>([]);
  const [plans, setPlans] = useState<GoalWeekPlan[]>([]);
  const [reviews, setReviews] = useState<WeekReviewRow[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busyGoal, setBusyGoal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyResult[] | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [items, setItems] = useState<DailyItem[]>([]);
  const [rewriting, setRewriting] = useState<string | null>(null);
  const [measures, setMeasures] = useState<GoalMeasure[]>([]);
  const [entries, setEntries] = useState<MeasureEntry[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setVerify(null);
    try {
      const { data, error: gErr } = await supabase.from("goals").select(PLAN_GOAL_COLUMNS);
      if (gErr) throw new Error(gErr.message);
      const all = (data as PlanGoal[]) ?? [];
      setGoals(all);
      const [week, ms] = await Promise.all([loadWeekData(weekStart), loadMeasures()]);
      setMeasures(ms);
      setEntries(await loadEntries(ms.filter((m) => m.kind === "outcome" && m.status === "active").map((m) => m.id)));
      // One card per effort measure (goals without measures keep their single weekly target).
      setPlans(planWeek(effortGoals(all, ms), week));
      setReviews(await loadReviews(weekStart));
      setItems(await loadDailyItems(weekStart, addDays(weekStart, 7)));
      setRemoved(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the review");
    } finally {
      setLoading(false);
    }
  }, [weekStart]);

  useEffect(() => {
    void load();
  }, [load]);

  const now = new Date();
  const missed = useMemo(
    () => goals.filter((g) => g.status === "active" && g.deadline && new Date(g.deadline) < now),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [goals]
  );
  const pendingCadence = goals.filter((g) => g.status === "approach_chosen" || g.status === "cadence_pending" || (g.status === "active" && !g.cadence_sessions_per_week));
  const needsPlan = goals.filter((g) => g.status === "active" && (g.cadence_sessions_per_week ?? 0) > 0 && !g.plan_mode);
  const firstMeasure = (goalId: string) => measures.find((m) => m.goal_id === goalId && m.kind === "effort" && m.status === "active")?.id;
  const reviewFor = (g: PlanGoal) => reviewForPlan(reviews, g, firstMeasure(g.id));
  const allReviewed = plans.length > 0 && plans.every((p) => reviewFor(p.goal));
  const outcomesFor = (goalId: string) => measures.filter((m) => m.goal_id === goalId && m.kind === "outcome" && m.status === "active");
  // Goals measured only by numbers you log (no weekly effort to plan).
  const outcomeOnly = goals.filter((g) => g.status === "active" && outcomesFor(g.id).length > 0 && !plans.some((p) => p.goal.id === g.id));
  const weekEnd = addDays(weekStart, 6);
  const isThisWeek = getWeekStart(now).getTime() === weekStart.getTime();

  async function approve(plan: GoalWeekPlan) {
    setBusyGoal(planKey(plan.goal));
    setError(null);
    try {
      const sessions = plan.proposed.filter((s) => !removed.has(s.key));
      await approveGoalWeek(plan, sessions, weekStart);
      if (sessions.length) scheduleAutoPush();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusyGoal(null);
    }
  }

  async function skip(plan: GoalWeekPlan) {
    setBusyGoal(planKey(plan.goal));
    try {
      const have = plan.goal.plan_mode === "count" ? plan.counted.length : plan.existing.length;
      await recordReview(plan.goal.id, weekStart, plan.target, have, "skipped", undefined, plan.goal.measure_id ?? "");
      setReviews(await loadReviews(weekStart));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    } finally {
      setBusyGoal(null);
    }
  }

  async function runVerify() {
    setVerifying(true);
    try {
      const [week, fresh] = await Promise.all([loadWeekData(weekStart), loadDailyItems(weekStart, addDays(weekStart, 7))]);
      setItems(fresh);
      const doneByGoal = new Map<string, number>();
      for (const p of plans) {
        const n = goalDayEntries(p.goal, sessionsOf(p), p.counted, fresh).filter((e) => e.done).length;
        doneByGoal.set(planKey(p.goal), n);
      }
      setVerify(verifyWeek(plans.map((p) => p.goal), week, doneByGoal));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't check the week");
    } finally {
      setVerifying(false);
    }
  }

  async function resolveMissed(goal: PlanGoal, stillPursuing: boolean | "reached") {
    setBusyGoal(goal.id);
    try {
      if (stillPursuing === "reached") {
        await completeGoal(goal.id);
      } else if (stillPursuing) {
        // Rev J: a fresh goal at Draft, carrying the pillar and where this one left off.
        const done = (goal.milestones ?? []).filter((m) => m.done).map((m) => m.title);
        const note = `Continuing from: ${goalShortName(goal)}${done.length ? ` (reached: ${done.join("; ")})` : ""}`;
        const { error: e1 } = await supabase.from("goals").insert({ pillar: goal.pillar, status: "draft", specific: null, relevant: note });
        if (e1) throw new Error(e1.message);
        await supabase.from("goals").update({ status: "missed", completed_at: new Date().toISOString() }).eq("id", goal.id);
      } else {
        await supabase.from("goals").update({ status: "abandoned", completed_at: new Date().toISOString() }).eq("id", goal.id);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update the goal");
    } finally {
      setBusyGoal(null);
    }
  }

  async function toggleDone(plan: GoalWeekPlan, entry: DayEntry, done: boolean) {
    setError(null);
    try {
      if (entry.counted) {
        const saved = await setCountedDone(plan.goal, entry.counted, weekStart, done);
        setItems((xs) => [...xs.filter((x) => x.id !== saved.id), saved]);
      } else if (entry.habitId && entry.start) {
        await setSessionDone(plan.goal, { item: entry.item, habitId: entry.habitId, start: entry.start, minutes: entry.minutes }, weekStart, done);
        setItems(await loadDailyItems(weekStart, addDays(weekStart, 7)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save");
    }
  }

  async function rewriteFocus(plan: GoalWeekPlan) {
    setRewriting(planKey(plan.goal));
    setError(null);
    try {
      const sessions = sessionsOf(plan).map((s) => ({ habitId: s.id, start: s.start, end: s.end }));
      await writeDailyPlan(plan.goal, sessions, weekStart, items);
      setItems(await loadDailyItems(weekStart, addDays(weekStart, 7)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't write the daily plan");
    } finally {
      setRewriting(null);
    }
  }

  async function toggleMilestone(goal: PlanGoal, id: string, done: boolean) {
    const next = await setMilestoneDone(goal, id, done);
    setGoals((gs) => gs.map((g) => (g.id === goal.id ? { ...g, milestones: next } : g)));
    setPlans((ps) => ps.map((p) => (p.goal.id === goal.id ? { ...p, goal: { ...p.goal, milestones: next } } : p)));
  }

  return (
    <div className="max-w-3xl mx-auto w-full p-4 md:p-6">
      <div className="flex items-center gap-3 mb-1">
        <ClipboardCheck className="w-5 h-5 text-blue-400" />
        <h1 className="text-xl font-semibold text-slate-100">Weekly Review</h1>
      </div>
      <p className="text-sm text-slate-400 mb-4">
        Goal by goal, in pillar priority order: confirm what lands on the calendar, then check that it held.
      </p>

      <div className="flex items-center gap-2 mb-5">
        <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="p-1.5 rounded-lg hover:bg-slate-800" aria-label="Previous week">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="text-sm font-medium tabular-nums">
          {dayLabel(weekStart)} – {dayLabel(weekEnd)}
          {isThisWeek && <span className="ml-2 text-xs text-blue-400">this week</span>}
        </div>
        <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="p-1.5 rounded-lg hover:bg-slate-800" aria-label="Next week">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {error && <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Preparing the week…</div>
      ) : (
        <div className="space-y-4">
          {missed.map((g) => (
            <div key={g.id} className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
              <div className="flex items-center gap-2 mb-1 text-rose-300 text-sm font-semibold"><Flag className="w-4 h-4" /> Deadline passed</div>
              <p className="text-sm text-slate-200 mb-1">{goalShortName(g)}</p>
              <p className="text-xs text-slate-400 mb-3">Did you reach it? If not, are you still pursuing it? A new goal starts at the SMART Gate from where this one left off.</p>
              <div className="flex flex-wrap gap-2">
                <button disabled={busyGoal === g.id} onClick={() => resolveMissed(g, "reached")} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-500 disabled:opacity-50">I reached it — mark complete</button>
                <button disabled={busyGoal === g.id} onClick={() => resolveMissed(g, true)} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-500 disabled:opacity-50">Yes — start a new goal</button>
                <button disabled={busyGoal === g.id} onClick={() => resolveMissed(g, false)} className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 disabled:opacity-50">No — let it go</button>
              </div>
            </div>
          ))}

          {pendingCadence.map((g) => (
            <div key={g.id} className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
              <div className="flex items-center gap-2 mb-1 text-slate-300 text-sm font-semibold"><Hourglass className="w-4 h-4" /> Waiting on a cadence</div>
              <p className="text-sm text-slate-200">{goalShortName(g)}</p>
              <p className="text-xs text-slate-400 mt-1">No weekly rhythm is settled yet, so nothing gets scheduled. Any update? Settle a number in the goal's coach chat when you're ready.</p>
              <button onClick={onOpenGoals} className="mt-2 text-xs text-blue-400 hover:underline">Open Goals</button>
            </div>
          ))}

          {needsPlan.map((g) => (
            <div key={g.id} className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="text-sm text-slate-200">{goalShortName(g)}</p>
              <p className="text-xs text-amber-200/80 mt-1">This goal has no plan yet. Open it in Goals and tap Generate plan.</p>
              <button onClick={onOpenGoals} className="mt-2 text-xs text-blue-400 hover:underline">Open Goals</button>
            </div>
          ))}

          {plans.length === 0 && missed.length === 0 && pendingCadence.length === 0 && needsPlan.length === 0 && (
            <p className="text-sm text-slate-400">No active goals with a plan yet.</p>
          )}

          {plans.map((plan, idx) => (
            <GoalCard
              key={planKey(plan.goal)}
              plan={plan}
              weekStart={weekStart}
              review={reviewFor(plan.goal)}
              firstOfGoal={plans.findIndex((p) => p.goal.id === plan.goal.id) === idx}
              outcomes={outcomesFor(plan.goal.id)}
              entries2={entries}
              onEntries={setEntries}
              removed={removed}
              busy={busyGoal === planKey(plan.goal)}
              onRemove={(s) => setRemoved((r) => new Set(r).add(s.key))}
              onApprove={() => approve(plan)}
              onSkip={() => skip(plan)}
              onMilestone={(id, done) => toggleMilestone(plan.goal, id, done)}
              entries={goalDayEntries(plan.goal, sessionsOf(plan), plan.counted, items)}
              onDone={(e, done) => toggleDone(plan, e, done)}
              onRewrite={() => rewriteFocus(plan)}
              rewriting={rewriting === planKey(plan.goal)}
            />
          ))}

          {outcomeOnly.map((g) => (
            <div key={g.id} className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
              <div className="flex items-start gap-2 mb-2">
                <span className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${getPillarColor(g.pillar).dot}`} />
                <div>
                  <div className="text-xs text-slate-400">{PILLAR_LABELS[g.pillar]}</div>
                  <p className="text-sm font-medium text-slate-100">{goalShortName(g)}</p>
                  <p className="text-xs text-slate-400 mt-0.5">No weekly effort to plan — just the numbers you log.</p>
                </div>
              </div>
              <div className="space-y-2">
                {outcomesFor(g.id).map((m) => (
                  <OutcomeTracker key={m.id} measure={m} entries={entries} onChange={setEntries} />
                ))}
              </div>
            </div>
          ))}

          {plans.length > 0 && (
            <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-slate-100">Check the week</p>
                  <p className="text-xs text-slate-400">Re-runs the scheduler to confirm every goal's sessions actually held.</p>
                </div>
                <button
                  onClick={runVerify}
                  disabled={verifying || !allReviewed}
                  title={allReviewed ? undefined : "Review every goal first"}
                  className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-500 disabled:opacity-40"
                >
                  {verifying ? "Checking…" : "Check"}
                </button>
              </div>
              {verify && (
                <ul className="mt-3 space-y-1.5">
                  {verify.map((v) => {
                    const g = plans.find((p) => planKey(p.goal) === v.key)?.goal;
                    const ok = v.held >= v.target;
                    return (
                      <li key={v.key} className="flex items-center gap-2 text-sm">
                        {ok ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <AlertTriangle className="w-4 h-4 text-amber-400" />}
                        <span className="text-slate-200 truncate">{g ? (g.measure_label ? `${g.measure_label} — ${goalShortName(g)}` : goalShortName(g)) : v.goalId}</span>
                        <span className="ml-auto tabular-nums text-slate-400">
                          {v.held}/{v.target}
                          <span className={v.done >= v.target ? "text-emerald-300" : ""}> · {v.done} done</span>
                          {v.offCalendar > 0 && <span className="text-amber-300"> · {v.offCalendar} bumped to the tray</span>}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GoalCard({
  plan,
  weekStart,
  review,
  removed,
  busy,
  onRemove,
  onApprove,
  onSkip,
  onMilestone,
  entries,
  onDone,
  onRewrite,
  rewriting,
  firstOfGoal,
  outcomes,
  entries2,
  onEntries,
}: {
  plan: GoalWeekPlan;
  weekStart: Date;
  review?: WeekReviewRow;
  firstOfGoal: boolean;
  outcomes: GoalMeasure[];
  entries2: MeasureEntry[];
  onEntries: (e: MeasureEntry[]) => void;
  removed: Set<string>;
  busy: boolean;
  onRemove: (s: ProposedSession) => void;
  onApprove: () => void;
  onSkip: () => void;
  onMilestone: (id: string, done: boolean) => void;
  entries: DayEntry[];
  onDone: (e: DayEntry, done: boolean) => void;
  onRewrite: () => void;
  rewriting: boolean;
}) {
  const g = plan.goal;
  const colors = getPillarColor(g.pillar);
  const isCount = g.plan_mode === "count";
  const kept = plan.proposed.filter((s) => !removed.has(s.key));
  const have = isCount ? plan.counted.length : plan.existing.length;
  const afterApproval = isCount ? have : have + kept.length;
  const due = milestonesDueSoon(g, weekStart);

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${colors.dot}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-slate-400">{PILLAR_LABELS[g.pillar]}</div>
          <p className="text-sm font-medium text-slate-100">{goalShortName(g)}</p>
          {g.measure_label && <p className="text-xs font-medium text-blue-300 mt-0.5">{g.measure_label}</p>}
          <p className="text-xs text-slate-400 mt-0.5">
            Target: {plan.target}× {g.weekly_target ?? "session"}
            {!isCount && g.session_minutes ? ` · ${g.session_minutes} min` : ""}
            {isCount ? " · counted from your calendar" : " · scheduled by the app"}
          </p>
        </div>
        {review && (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              review.status === "approved" ? "bg-emerald-500/15 text-emerald-300" : review.status === "short" ? "bg-amber-500/15 text-amber-300" : "bg-slate-700 text-slate-300"
            }`}
          >
            {review.status === "approved" ? "Approved" : review.status === "short" ? `Short ${review.scheduled_count}/${review.target_count}` : "Skipped"}
          </span>
        )}
      </div>

      {isCount ? (
        <div className="mt-3">
          <p className={`text-xs mb-1.5 ${have >= plan.target ? "text-emerald-300" : "text-amber-300"}`}>
            {have} of {plan.target} on the calendar this week · {entries.filter((e) => e.done).length} ticked done
          </p>
          <DayList entries={entries} onDone={onDone} />
          {have < plan.target && (
            <p className="text-xs text-slate-500 mt-1.5">Short — add or move sessions at the source (e.g. the Runna app), then reopen the review.</p>
          )}
        </div>
      ) : (
        <div className="mt-3">
          {entries.length > 0 && (
            <div className="mb-2">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Day by day · {entries.filter((e) => e.done).length}/{entries.length} done</p>
                <button onClick={onRewrite} disabled={rewriting} className="flex items-center gap-1 text-[11px] text-blue-400 hover:underline disabled:opacity-50" title="Write a fresh focus for every session not yet done">
                  <RefreshCw className={`w-3 h-3 ${rewriting ? "animate-spin" : ""}`} /> {rewriting ? "Writing…" : entries.some((e) => !e.focus) ? "Write focus" : "Rewrite focus"}
                </button>
              </div>
              <DayList entries={entries} onDone={onDone} />
            </div>
          )}
          {!review && plan.proposed.length > 0 && (
            <ul className="space-y-1">
              {plan.proposed.map((s) => {
                const gone = removed.has(s.key);
                return (
                  <li key={s.key} className={`flex items-center gap-2 text-sm tabular-nums ${gone ? "text-slate-600 line-through" : "text-slate-200"}`}>
                    <span className="w-28">{dayLabel(s.start)}</span>
                    <span>{hhmm(s.start)}–{hhmm(s.end)}</span>
                    {!gone && (
                      <button onClick={() => onRemove(s)} className="ml-auto p-1 rounded text-slate-500 hover:text-rose-300 hover:bg-rose-500/10" aria-label="Remove this session">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {plan.unplaced > 0 && !review && (
            <p className="text-xs text-amber-300 mt-1.5">
              {plan.unplaced} session{plan.unplaced > 1 ? "s" : ""} couldn't fit this week (preferred time, UTA days and higher-priority goals come first).
            </p>
          )}
        </div>
      )}

      {firstOfGoal && outcomes.length > 0 && (
        <div className="mt-3 border-t border-slate-800 pt-2 space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Numbers to log</p>
          {outcomes.map((m) => (
            <OutcomeTracker key={m.id} measure={m} entries={entries2} onChange={onEntries} />
          ))}
        </div>
      )}

      {firstOfGoal && due.length > 0 && (
        <div className="mt-3 border-t border-slate-800 pt-2">
          <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Checkpoints coming up</p>
          {due.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-xs text-slate-300 py-0.5">
              <input type="checkbox" checked={m.done} onChange={(e) => onMilestone(m.id, e.target.checked)} className="accent-blue-600" />
              <span className="tabular-nums text-slate-500 w-20">{m.due.slice(5)}</span>
              <span>{m.title}</span>
            </label>
          ))}
        </div>
      )}

      {!review && (
        <div className="mt-3 flex gap-2">
          <button onClick={onApprove} disabled={busy} className="flex-1 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 disabled:opacity-50">
            {busy ? "Saving…" : isCount ? "Confirm" : kept.length ? `Approve & add ${kept.length} to calendar` : "Approve"}
          </button>
          <button onClick={onSkip} disabled={busy} className="px-3 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 disabled:opacity-50">
            Skip this week
          </button>
        </div>
      )}
      {!review && afterApproval < plan.target && (
        <p className="mt-1.5 text-[11px] text-slate-500">Approving now records this week as short ({afterApproval}/{plan.target}).</p>
      )}
    </div>
  );
}

function sessionsOf(plan: GoalWeekPlan) {
  return plan.existing.map((h) => ({ id: h.id, start: new Date(h.search_start), end: new Date(h.search_end) }));
}

function DayList({ entries, onDone }: { entries: DayEntry[]; onDone: (e: DayEntry, done: boolean) => void }) {
  const now = new Date();
  return (
    <ul className="space-y-1.5">
      {entries.map((e) => {
        const past = (e.start ?? new Date(e.day.getTime() + 86400000)) < now;
        return (
          <li key={e.key} className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={e.done}
              onChange={(ev) => onDone(e, ev.target.checked)}
              className="mt-0.5 accent-emerald-500"
              aria-label={`Mark ${e.focus ?? e.title} done`}
            />
            <span className={`w-24 shrink-0 tabular-nums ${e.done ? "text-slate-500" : "text-slate-400"}`}>
              {e.day.toLocaleDateString("en-US", { weekday: "short", day: "numeric" })} {e.start ? hhmm(e.start) : "all day"}
            </span>
            <span className="min-w-0">
              <span className={e.done ? "text-slate-500 line-through" : past ? "text-amber-200/90" : "text-slate-200"}>{e.focus ?? e.title}</span>
              {e.steps.length > 0 && !e.done && (
                <span className="block text-slate-500">{e.steps.join(" · ")}</span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
