import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  paceNote,
  paceStatus,
  reviewForPlan,
  sessionName,
  setMilestoneDone,
  verifyWeek,
  type GoalWeekPlan,
  type PlanGoal,
  type ProposedSession,
  type VerifyResult,
  type WeekReviewRow,
  type WeekData,
} from "@/lib/goalPlanning";
import { goalDayEntries, loadDailyItems, setCountedDone, setSessionDone, writeDailyPlan, type DailyItem, type DayEntry } from "@/lib/goalDaily";
import { DAY_SHORT, daysText, effortGoals, fmt, loadEntries, loadMeasures, measuredCheckpoint, outcomeStatus, planKey, resolveMilestones, type GoalMeasure, type MeasureEntry } from "@/lib/measures";
import { OutcomeTracker } from "@/components/MeasureWidgets";
import { completeGoal } from "@/lib/goalCompletion";
import { blockRanges, loadLifeBlocks, DEFAULT_BLOCKS } from "@/lib/lifeBlocks";
import { CalendarView, type Allow, type CalendarEmbed, type EmbedProposal } from "@/components/CalendarView";
import type { PlacedItem } from "@/lib/types";

// Names of the big life blocks, for "Stays out of: …" (filled on load).
let blockNames: Record<string, string> = Object.fromEntries(DEFAULT_BLOCKS.map((b) => [b.key, b.label]));
const blockLabel = (key: string) => blockNames[key] ?? key.replace(/_/g, " ");

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
  const [weekData, setWeekData] = useState<WeekData | null>(null);
  const [items, setItems] = useState<DailyItem[]>([]);
  const [rewriting, setRewriting] = useState<string | null>(null);
  const [measures, setMeasures] = useState<GoalMeasure[]>([]);
  const [entries, setEntries] = useState<MeasureEntry[]>([]);
  // The week's calendar beside the cards (a tab on phones).
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobileTab, setMobileTab] = useState<"review" | "calendar">("review");
  // Proposed sessions you dragged or resized in the calendar (saved when you approve).
  const [calToken, setCalToken] = useState(0);
  const [moved, setMoved] = useState<Record<string, { start: Date; end: Date; allow: Allow }>>({});

  useEffect(() => {
    setMoved({});
    setRemoved(new Set());
    setSelectedKey(null);
  }, [weekStart]);

  const load = useCallback(async (opts: { quiet?: boolean } = {}) => {
    if (!opts.quiet) setLoading(true);
    setError(null);
    try {
      const { data, error: gErr } = await supabase.from("goals").select(PLAN_GOAL_COLUMNS);
      if (gErr) throw new Error(gErr.message);
      const all = (data as PlanGoal[]) ?? [];
      // A goal whose weekly cadence is settled belongs in the plan. Older coach chats
      // could leave one a step behind ("approach chosen"); move it on here.
      const stuck = all.filter((g) => g.status === "approach_chosen" && g.cadence_confirmed && (g.cadence_sessions_per_week ?? 0) > 0);
      if (stuck.length) {
        const { error: sErr } = await supabase.from("goals").update({ status: "active" }).in("id", stuck.map((g) => g.id));
        if (!sErr) for (const g of stuck) g.status = "active";
      }
      setGoals(all);
      const [week, ms, blocks] = await Promise.all([loadWeekData(weekStart), loadMeasures(), loadLifeBlocks()]);
      blockNames = Object.fromEntries(blocks.map((b) => [b.key, b.label]));
      setWeekData(week);
      setMeasures(ms);
      setEntries(await loadEntries(ms.filter((m) => m.kind === "outcome" && m.status === "active").map((m) => m.id)));
      // One card per effort measure (goals without measures keep their single weekly target).
      setPlans(planWeek(effortGoals(all, ms), week, new Date(), blockRanges(blocks, week.busy, week.weekStart, week.weekEnd)));
      setReviews(await loadReviews(weekStart));
      setItems(await loadDailyItems(weekStart, addDays(weekStart, 7)));
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
  const outcomesFor = (goalId: string) => measures.filter((m) => m.goal_id === goalId && m.kind === "outcome" && m.status === "active");
  // Goals measured only by numbers you log (no weekly effort to plan).
  const outcomeOnly = goals.filter((g) => g.status === "active" && outcomesFor(g.id).length > 0 && !plans.some((p) => p.goal.id === g.id));
  // Plans as shown: proposals sit wherever you moved them in the calendar.
  const viewPlans = useMemo(
    () =>
      plans.map((p) =>
        p.proposed.some((s) => moved[s.key])
          ? {
              ...p,
              proposed: p.proposed.map((s) => {
                const m = moved[s.key];
                return m ? { ...s, start: m.start, end: m.end, movedFrom: undefined, utaOverride: !!m.allow.uta, quietOverride: !!m.allow.quiet } : s;
              }),
            }
          : p
      ),
    [plans, moved]
  );
  // The review card each saved calendar item belongs to (🎯 sessions, counted events).
  const ownerMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of plans) {
      for (const h of p.existing) m.set(h.id, planKey(p.goal));
      for (const c of p.counted) m.set(c.id, planKey(p.goal));
    }
    return m;
  }, [plans]);
  const ownerOf = useCallback(
    (it: PlacedItem) => ownerMap.get(it.recurringItemId ?? it.id.replace(/^kept-/, "").split("--")[0]) ?? ownerMap.get(it.id),
    [ownerMap]
  );
  const proposals = useMemo<EmbedProposal[]>(
    () =>
      viewPlans.flatMap((p) =>
        p.startsNext || reviewForPlan(reviews, p.goal, measures.find((m) => m.goal_id === p.goal.id && m.kind === "effort" && m.status === "active")?.id)
          ? []
          : p.proposed
              .filter((s) => !removed.has(s.key))
              .map((s) => ({
                key: s.key,
                name: sessionName(p.goal),
                start: s.start,
                end: s.end,
                pillar: p.goal.pillar,
                context: p.goal.session_context ?? "other",
                owner: planKey(p.goal),
                utaOverride: s.utaOverride,
                quietOverride: s.quietOverride,
              }))
      ),
    [viewPlans, reviews, measures, removed]
  );
  const loadRef = useRef(load);
  loadRef.current = load;
  const embed: CalendarEmbed = {
    proposals,
    ownerOf,
    selectedKey,
    onSelectOwner: (k) => {
      setSelectedKey(k);
      if (k && window.matchMedia("(min-width: 1024px)").matches) document.getElementById(`review-card-${k}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    onMoveProposal: (key, start, end, allow) => setMoved((m) => ({ ...m, [key]: { start, end, allow } })),
    onRemoveProposal: (key) => setRemoved((r) => new Set(r).add(key)),
    onDataChanged: () => void loadRef.current({ quiet: true }),
    reloadToken: calToken,
  };

  // Running tally for the week, fed by the calendar: what's on it and what's ticked done.
  const tally = useMemo(() => {
    if (!weekData || !plans.length) return null;
    const entriesBy = new Map(plans.map((p) => [planKey(p.goal), goalDayEntries(p.goal, sessionsOf(p), p.counted, items)]));
    const doneBy = new Map([...entriesBy].map(([k, es]) => [k, es.filter((e) => e.done).length]));
    const t = new Date();
    return verifyWeek(plans.map((p) => p.goal), weekData, doneBy).map((v) => ({
      ...v,
      missed: (entriesBy.get(v.key) ?? []).filter((e) => !e.done && (e.start ? new Date(e.start.getTime() + (e.minutes ?? 30) * 60000) : addDays(e.day, 1)) < t).length,
    }));
  }, [weekData, plans, items]);

  const weekEnd = addDays(weekStart, 6);
  const isThisWeek = getWeekStart(now).getTime() === weekStart.getTime();

  async function approve(plan: GoalWeekPlan) {
    setBusyGoal(planKey(plan.goal));
    setError(null);
    try {
      const sessions = plan.proposed.filter((s) => !removed.has(s.key));
      await approveGoalWeek(plan, sessions, weekStart);
      if (sessions.length) {
        scheduleAutoPush();
        setCalToken((t) => t + 1);
      }
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

  // Checkpoints that track a logged number close themselves once their date passes.
  useEffect(() => {
    for (const g of goals) {
      if (g.status !== "active" || !(g.milestones ?? []).length) continue;
      const outs = measures.filter((m) => m.goal_id === g.id && m.kind === "outcome" && m.status === "active");
      if (!outs.length) continue;
      const next = resolveMilestones(g.milestones ?? [], outs, entries);
      if (!next) continue;
      setGoals((gs) => gs.map((x) => (x.id === g.id ? { ...x, milestones: next } : x)));
      setPlans((ps) => ps.map((p) => (p.goal.id === g.id ? { ...p, goal: { ...p.goal, milestones: next } } : p)));
      void supabase.from("goals").update({ milestones: next }).eq("id", g.id);
    }
  }, [goals, measures, entries]);

  async function toggleMilestone(goal: PlanGoal, id: string, done: boolean) {
    const next = await setMilestoneDone(goal, id, done);
    setGoals((gs) => gs.map((g) => (g.id === goal.id ? { ...g, milestones: next } : g)));
    setPlans((ps) => ps.map((p) => (p.goal.id === goal.id ? { ...p, goal: { ...p.goal, milestones: next } } : p)));
  }

  return (
    <div className="max-w-[1600px] mx-auto w-full p-4 md:p-6">
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

      <div className="lg:hidden mb-4 grid grid-cols-2 rounded-lg bg-slate-900 border border-slate-800 p-1 text-sm">
        {(["review", "calendar"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setMobileTab(t)}
            className={`py-1.5 rounded-md font-medium ${mobileTab === t ? "bg-blue-600 text-white" : "text-slate-400"}`}
          >
            {t === "review" ? "Review" : "Calendar"}
          </button>
        ))}
      </div>

      <div className="lg:grid lg:grid-cols-[minmax(360px,500px)_minmax(0,1fr)] lg:gap-5 lg:items-start">
      <div className={mobileTab === "calendar" ? "hidden lg:block" : ""}>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Preparing the week…</div>
      ) : (
        <div className="space-y-4">
          {tally && <WeekTally rows={tally} plans={plans} isThisWeek={isThisWeek} />}

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

          {viewPlans.map((plan, idx) => (
            <div
              key={planKey(plan.goal)}
              id={`review-card-${planKey(plan.goal)}`}
              onClickCapture={() => setSelectedKey(planKey(plan.goal))}
              className={`rounded-xl transition-shadow ${selectedKey === planKey(plan.goal) ? "ring-2 ring-blue-500" : ""}`}
            >
            <GoalCard
              plan={plan}
              weekStart={weekStart}
              review={reviewFor(plan.goal)}
              firstOfGoal={viewPlans.findIndex((p) => p.goal.id === plan.goal.id) === idx}
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
            </div>
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
                  <OutcomeTracker key={m.id} measure={m} entries={entries} onChange={setEntries} deadline={g.deadline} />
                ))}
              </div>
            </div>
          ))}

        </div>
      )}
      </div>
      <div
        className={`${mobileTab === "calendar" ? "flex" : "hidden"} lg:flex flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-950 lg:sticky lg:top-4 h-[78dvh] lg:h-[calc(100dvh-2rem)]`}
      >
        <CalendarView weekStart={weekStart} setWeekStart={(d) => setWeekStart(getWeekStart(d))} embed={embed} />
      </div>
      </div>
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
  // Ticked checkpoints stay in view (struck through, with Undo) instead of vanishing.
  const [ticked, setTicked] = useState<string[]>([]);
  const [showDone, setShowDone] = useState(false);
  const soon = new Set(milestonesDueSoon(g, weekStart).map((m) => m.id));
  const todayStr = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const all = (g.milestones ?? []).slice().sort((a, b) => a.due.localeCompare(b.due));
  // Coming up: not done, date not passed (plus ones you just ticked, with Undo).
  const due = all.filter((m) => (soon.has(m.id) && !m.done && m.due >= todayStr) || (m.done && ticked.includes(m.id)));
  // Date passed and nothing closed it (no number logged, or not tied to a number): tick it yourself.
  const pastOpen = all.filter((m) => !m.done && m.due < todayStr);
  // Closed in the last two weeks (on their own or by you) stay in view; older ones fold away.
  const recentCut = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const closedRecent = all.filter((m) => m.done && !ticked.includes(m.id) && m.due < todayStr && m.due >= recentCut);
  const doneEarlier = all.filter((m) => m.done && !ticked.includes(m.id) && !closedRecent.includes(m));
  const unit = (o: GoalMeasure) => (o.unit ? ` ${o.unit}` : "");
  /** "re-planned: ≤ 200.8 lb" for a coming checkpoint whose number was re-spread after a miss. */
  const replanNote = (due: string) => {
    const o = measuredCheckpoint(outcomes, due);
    if (!o) return null;
    const r = outcomeStatus(o, entries2).replanned.find((x) => x.due === due);
    return r ? `now ${o.direction === "up" ? "≥" : "≤"} ${fmt(r.now)}${unit(o)} after the missed checkpoint` : null;
  };
  const resultChip = (m: { result?: "met" | "close" | "missed" | null; value?: number | null; due: string }) => {
    if (!m.result) return <span className="text-slate-500">done</span>;
    const o = measuredCheckpoint(outcomes, m.due);
    const v = m.value !== null && m.value !== undefined && o ? ` (${fmt(m.value)}${unit(o)})` : "";
    const cls = m.result === "met" ? "text-emerald-300" : m.result === "close" ? "text-amber-300" : "text-rose-300";
    return <span className={cls}>{m.result}{v}</span>;
  };
  const tick = (id: string, done: boolean) => {
    if (done) setTicked((t) => [...t, id]);
    onMilestone(id, done);
  };

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${colors.dot}`} />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-slate-400">{PILLAR_LABELS[g.pillar]}</div>
          <p className="text-sm font-medium text-slate-100">{goalShortName(g)}</p>
          {g.measure_label && <p className="text-xs font-medium text-blue-300 mt-0.5">{g.measure_label}</p>}
          <p className="text-xs text-slate-400 mt-0.5">
            {plan.pace
              ? `${plan.pace.perPeriod}× ${g.weekly_target ?? "session"} a ${plan.pace.period === "day" ? "day" : plan.pace.period}`
              : plan.startsNext
                ? `${g.cadence_sessions_per_week ?? 0}× ${g.weekly_target ?? "session"} a ${g.period === "day" ? "day" : "week"}${g.days?.length ? ` on ${daysText(g.days)}` : ""}`
                : `Target: ${plan.target}× ${g.weekly_target ?? "session"}${g.days?.length ? ` on ${daysText(g.days)}` : ""}`}
            {!isCount && g.session_minutes ? ` · ${g.session_minutes} min` : ""}
            {isCount ? " · counted from your calendar" : " · scheduled by the app"}
          </p>
          {!!plan.banked && (
            <p className="text-xs text-sky-300 mt-0.5">
              {plan.banked} banked from last week's extra session{plan.banked === 1 ? "" : "s"} — {plan.target} needed this week instead of {plan.target + plan.banked}.
            </p>
          )}
          {plan.pace && plan.pace.period !== "day" && (
            <p className="text-xs text-slate-300 mt-0.5">
              {paceNote(plan.pace, have)}
              {paceStatus(plan.pace, have) === "open" && plan.proposed.length > 0 && !review && " · take this week's slot or skip, and it's offered again next week"}
            </p>
          )}
          {!!g.blocked_blocks?.length && <p className="text-[11px] text-slate-500 mt-0.5">Stays out of: {g.blocked_blocks.map(blockLabel).join(", ")}</p>}
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
                    {s.movedFrom && !gone && (
                      <span className="text-[11px] text-amber-300" title="Your chosen day had no open slot; this is the nearest open day. Move it after approving if you like.">
                        {DAY_SHORT[s.movedFrom.getDay()]} full → nearest open day
                      </span>
                    )}
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
          {plan.startsNext && !review && (
            <p className="text-xs text-slate-300 mt-1">
              Added this week — it starts next week
              {g.days?.length ? ` on ${daysText(g.days)}` : ""}. Nothing to schedule here; open next week's review to place its sessions.
            </p>
          )}
          {plan.unplaced > 0 && !review && (
            <p className="text-xs text-amber-300 mt-1.5">
              {plan.unplaced} session{plan.unplaced > 1 ? "s" : ""} couldn't fit this week (
              {g.days?.length ? `no open slot on ${daysText(g.days)} or any nearby day; ` : ""}preferred time, UTA days and higher-priority goals come first).
            </p>
          )}
        </div>
      )}

      {firstOfGoal && outcomes.length > 0 && (
        <div className="mt-3 border-t border-slate-800 pt-2 space-y-2">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Numbers to log</p>
          {outcomes.map((m) => (
            <OutcomeTracker key={m.id} measure={m} entries={entries2} onChange={onEntries} deadline={g.deadline} />
          ))}
        </div>
      )}

      {firstOfGoal && (due.length > 0 || doneEarlier.length > 0 || pastOpen.length > 0 || closedRecent.length > 0) && (
        <div className="mt-3 border-t border-slate-800 pt-2">
          {closedRecent.length > 0 && (
            <div className="mb-1.5">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Recent checkpoints</p>
              {closedRecent.map((m) => (
                <div key={m.id} className="flex items-center gap-2 text-xs py-0.5">
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-slate-500" />
                  <span className="tabular-nums text-slate-500 w-[4.25rem] shrink-0">{m.due.slice(5)}</span>
                  <span className="flex-1 min-w-0 text-slate-400">{m.title}</span>
                  <span className="shrink-0 text-[11px]">{resultChip(m)}</span>
                  {!m.result && (
                    <button onClick={() => tick(m.id, false)} className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-300 hover:bg-blue-500/10">
                      Not done
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {pastOpen.length > 0 && (
            <div className="mb-1.5">
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Past — tick if done</p>
              {pastOpen.map((m) => {
                const o = measuredCheckpoint(outcomes, m.due);
                return (
                  <label key={m.id} className="flex items-center gap-2 text-xs text-slate-300 py-0.5 cursor-pointer">
                    <input type="checkbox" checked={false} onChange={() => tick(m.id, true)} className="accent-blue-600" />
                    <span className="tabular-nums text-slate-500 w-20 shrink-0">{m.due.slice(5)}</span>
                    <span className="flex-1 min-w-0">{m.title}</span>
                    {o && <span className="shrink-0 text-[11px] text-amber-300">log your {o.label.toLowerCase()} for this date</span>}
                  </label>
                );
              })}
            </div>
          )}
          {due.length > 0 && <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Checkpoints coming up</p>}
          {due.map((m) => (
            <div key={m.id} className="flex items-center gap-2 text-xs text-slate-300 py-0.5">
              <label className="flex flex-1 min-w-0 items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={m.done} onChange={(e) => tick(m.id, e.target.checked)} className="accent-blue-600" />
                <span className="tabular-nums text-slate-500 w-20 shrink-0">{m.due.slice(5)}</span>
                <span className={m.done ? "text-slate-500 line-through" : ""}>
                  {m.title}
                  {!m.done && replanNote(m.due) && <span className="ml-1.5 text-[11px] text-sky-300/90">· {replanNote(m.due)}</span>}
                </span>
              </label>
              {m.done && (
                <button onClick={() => tick(m.id, false)} className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-300 hover:bg-blue-500/10">
                  Undo
                </button>
              )}
            </div>
          ))}
          {doneEarlier.length > 0 && (
            <div className="mt-1">
              <button onClick={() => setShowDone((v) => !v)} className="text-[11px] text-slate-500 hover:text-slate-300">
                {showDone ? "Hide" : "Show"} done checkpoints ({doneEarlier.length})
              </button>
              {showDone &&
                doneEarlier.map((m) => (
                  <div key={m.id} className="flex items-center gap-2 text-xs py-0.5">
                    <span className="tabular-nums text-slate-600 w-20 pl-6 shrink-0">{m.due.slice(5)}</span>
                    <span className="flex-1 min-w-0 text-slate-500 line-through">{m.title}</span>
                    {m.result ? (
                      <span className="shrink-0 text-[11px]">{resultChip(m)}</span>
                    ) : (
                      <button onClick={() => tick(m.id, false)} className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-blue-300 hover:bg-blue-500/10">
                        Not done
                      </button>
                    )}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}

      {!review && !plan.startsNext && (
        <div className="mt-3 flex gap-2">
          <button onClick={onApprove} disabled={busy} className="flex-1 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 disabled:opacity-50">
            {busy ? "Saving…" : isCount ? "Confirm" : kept.length ? `Approve & add ${kept.length} to calendar` : "Approve"}
          </button>
          <button onClick={onSkip} disabled={busy} className="px-3 py-2 rounded-lg bg-slate-800 text-slate-300 text-sm hover:bg-slate-700 disabled:opacity-50">
            Skip this week
          </button>
        </div>
      )}
      {!review && !plan.startsNext && afterApproval < (plan.pace ? plan.pace.required : plan.target) && (
        <p className="mt-1.5 text-[11px] text-slate-500">Approving now records this week as short ({afterApproval}/{plan.pace ? plan.pace.required : plan.target}).</p>
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

type TallyRow = VerifyResult & { missed: number };

/** "This week so far": a live tally per goal, fed by the calendar as sessions are ticked off. */
function WeekTally({ rows, plans, isThisWeek }: { rows: TallyRow[]; plans: GoalWeekPlan[]; isThisWeek: boolean }) {
  const doneAll = rows.reduce((a, r) => a + Math.min(r.done, Math.max(r.target, r.held)), 0);
  const dueAll = rows.reduce((a, r) => a + Math.max(r.target, r.held), 0);
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold text-slate-100">{isThisWeek ? "This week so far" : "The week's tally"}</p>
        <p className="text-xs tabular-nums text-slate-400">
          <span className="text-slate-100 font-semibold">{doneAll}</span> of {dueAll} done
        </p>
      </div>
      <p className="text-[11px] text-slate-500 mb-2">Updates as you tick sessions off here or in the calendar.</p>
      <ul className="space-y-2.5">
        {rows.map((r) => {
          const plan = plans.find((p) => planKey(p.goal) === r.key);
          const g = plan?.goal;
          const name = g ? g.measure_label ?? g.weekly_target ?? goalShortName(g) : r.goalId;
          const st = r.pace ? paceStatus(r.pace, r.held) : null;
          // Monthly/quarterly counts still open with nothing booked this week aren't behind.
          const open = st === "open" && r.held === 0;
          const bookedElsewhere = st === "booked" && r.held === 0;
          const goalFor = Math.max(r.target, r.held);
          const complete = goalFor > 0 && r.done >= goalFor;
          const short = !open && !bookedElsewhere && (st === "late" || (!r.pace && r.held < r.target) || r.offCalendar > 0);
          const pct = goalFor ? Math.min(100, Math.round((r.done / goalFor) * 100)) : 0;
          return (
            <li key={r.key}>
              <div className="flex items-center gap-2 text-sm">
                {complete || bookedElsewhere ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                ) : short ? (
                  <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
                ) : (
                  <span className={`w-3 h-3 mx-0.5 shrink-0 rounded-full border-2 ${open ? "border-slate-500 border-dashed" : "border-blue-400"}`} />
                )}
                <span className="min-w-0 flex-1 truncate text-slate-200" title={g ? goalShortName(g) : undefined}>
                  {name}
                </span>
                <span className="shrink-0 tabular-nums text-xs text-slate-300">
                  {open || bookedElsewhere ? (
                    <span className="text-slate-400">{open ? "open" : "booked"}</span>
                  ) : (
                    <>
                      <span className={complete ? "text-emerald-300 font-semibold" : "font-semibold"}>{r.done}</span>/{goalFor} done
                    </>
                  )}
                </span>
              </div>
              {!open && !bookedElsewhere && goalFor > 0 && (
                <div className="ml-6 mt-1 h-1 rounded-full bg-slate-800 overflow-hidden">
                  <div className={`h-full rounded-full ${complete ? "bg-emerald-500" : "bg-blue-500"}`} style={{ width: `${pct}%` }} />
                </div>
              )}
              <p className="ml-6 mt-0.5 text-[11px] text-slate-500">
                {r.pace
                  ? paceNote(r.pace, r.held)
                  : `${r.held} of ${r.target} on the calendar${plan?.banked ? ` · ${plan.banked} banked from last week` : ""}`}
                {r.missed > 0 && <span className="text-amber-300/90"> · {r.missed} past, not ticked</span>}
                {r.offCalendar > 0 && <span className="text-amber-300"> · {r.offCalendar} bumped to the tray</span>}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
