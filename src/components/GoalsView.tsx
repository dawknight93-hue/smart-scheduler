import { useEffect, useRef, useState } from "react";
import { Plus, Send, ArrowLeft, CheckCircle2, Loader2, Trash2 } from "lucide-react";
import { PlannerFeedback } from "@/components/PlannerFeedback";
import { GoalCompletionBar } from "@/components/GoalCompletionBar";
import { STATUS_LABELS } from "@/lib/goalCompletion";
import { supabase } from "@/lib/supabase";
import { PILLARS, PILLAR_LABELS, getPillarColor, LifePillar } from "@/lib/types";
import { GoalPlanPanel } from "@/components/GoalPlanPanel";

const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/smart-gate`;
const HEADERS = {
  Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};

interface GoalRow {
  id: string;
  pillar: LifePillar;
  specific: string | null;
  measurable: string | null;
  achievable: string | null;
  relevant: string | null;
  time_bound: string | null;
  status: string;
  completed_at?: string | null;
  outcome_note?: string | null;
  created_at: string;
  cadence_sessions_per_week: number | null;
  cadence_label: string | null;
  cadence_confirmed: boolean;
}

interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

interface SmartFields {
  specific: string | null;
  measurable: string | null;
  achievable: string | null;
  relevant: string | null;
  time_bound: string | null;
}

const EMPTY_SMART: SmartFields = {
  specific: null,
  measurable: null,
  achievable: null,
  relevant: null,
  time_bound: null,
};

const SMART_LABELS: { key: keyof SmartFields; label: string }[] = [
  { key: "specific", label: "Specific" },
  { key: "measurable", label: "Measurable" },
  { key: "achievable", label: "Achievable" },
  { key: "relevant", label: "Relevant" },
  { key: "time_bound", label: "Time-bound" },
];

async function callSmartGate(body: Record<string, unknown>) {
  const res = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const FUNCTION_URL_RESEARCH = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/goal-research`;

async function callGoalResearch(body: Record<string, unknown>) {
  const res = await fetch(FUNCTION_URL_RESEARCH, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export function GoalsView() {
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [loadingGoals, setLoadingGoals] = useState(true);
  const [activeGoalId, setActiveGoalId] = useState<string | null>(null);
  const [showNewGoal, setShowNewGoal] = useState(false);

  const loadGoals = async () => {
    setLoadingGoals(true);
    const { data, error } = await supabase
      .from("goals")
      .select("id, pillar, specific, measurable, achievable, relevant, time_bound, status, created_at, cadence_sessions_per_week, cadence_label, cadence_confirmed, completed_at, outcome_note")
      .order("created_at", { ascending: false });
    if (!error && data) {
      const rows = data as GoalRow[];
      // Cadence settled but left a step behind by an older coach chat: it's active.
      const stuck = rows.filter((g) => g.status === "approach_chosen" && g.cadence_confirmed && (g.cadence_sessions_per_week ?? 0) > 0);
      if (stuck.length) {
        const { error: sErr } = await supabase.from("goals").update({ status: "active" }).in("id", stuck.map((g) => g.id));
        if (!sErr) for (const g of stuck) g.status = "active";
      }
      setGoals(rows);
    }
    setLoadingGoals(false);
  };

  useEffect(() => {
    loadGoals();
  }, []);

  if (activeGoalId) {
    return (
      <GoalChat
        goalId={activeGoalId}
        onBack={() => {
          setActiveGoalId(null);
          loadGoals();
        }}
      />
    );
  }

  return (
    <div className="w-full max-w-3xl mx-auto p-4 md:p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-slate-100">Goals</h1>
        <button
          onClick={() => setShowNewGoal(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Goal
        </button>
      </div>

      {showNewGoal && (
        <NewGoalModal
          onClose={() => setShowNewGoal(false)}
          onCreated={(id) => {
            setShowNewGoal(false);
            setActiveGoalId(id);
          }}
        />
      )}

      {loadingGoals ? (
        <div className="text-slate-400 text-sm">Loading goals...</div>
      ) : goals.length === 0 ? (
        <div className="text-center py-16 text-slate-400">
          <p className="mb-2">No goals yet.</p>
          <p className="text-sm">Start one and the SMART Gate coach will help you shape it.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {(
            [
              { key: "open", title: null, list: goals.filter((g) => !["complete", "abandoned"].includes(g.status)) },
              { key: "done", title: "Completed", list: goals.filter((g) => g.status === "complete") },
              { key: "closed", title: "Let go", list: goals.filter((g) => g.status === "abandoned") },
            ] as const
          ).map((sec) =>
            sec.list.length === 0 ? null : (
              <div key={sec.key}>
                {sec.title && <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{sec.title} · {sec.list.length}</h2>}
                <div className="grid gap-3">
                  {sec.list.map((goal) => (
                    <GoalCard
                      key={goal.id}
                      goal={goal}
                      onClick={() => setActiveGoalId(goal.id)}
                      onDelete={async () => {
                        if (!window.confirm("Delete this goal and all its conversation history?")) return;
                        await supabase.from("goals").delete().eq("id", goal.id);
                        loadGoals();
                      }}
                    />
                  ))}
                </div>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

function GoalCard({ goal, onClick, onDelete }: { goal: GoalRow; onClick: () => void; onDelete: () => void }) {
  const colors = getPillarColor(goal.pillar);
  const title = goal.specific || "New draft goal";
  const statusLabel =
    goal.status === "complete" && goal.completed_at
      ? `Completed ${new Date(goal.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`
      : STATUS_LABELS[goal.status] ?? goal.status;

  return (
    <div
      onClick={onClick}
      className={`relative text-left p-4 rounded-lg border ${colors.border} ${colors.soft} hover:brightness-110 transition-all cursor-pointer group`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
        <span className={`text-xs font-medium ${colors.text}`}>{PILLAR_LABELS[goal.pillar]}</span>
        <span className="text-xs text-slate-500 ml-auto">{statusLabel}</span>
        {goal.cadence_sessions_per_week !== null && (
          <span
            className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium ${
              goal.cadence_confirmed
                ? "border border-emerald-600/50 text-emerald-400 bg-emerald-600/10"
                : "border border-dashed border-slate-600 text-slate-400 bg-slate-800/50"
            }`}
          >
            {goal.cadence_label || `${goal.cadence_sessions_per_week}x/week`}
          </span>
        )}
      </div>
      <p className={`text-sm line-clamp-2 pr-8 ${goal.status === "complete" || goal.status === "abandoned" ? "text-slate-400" : "text-slate-200"}`}>{title}</p>
      {goal.outcome_note && <p className="mt-0.5 text-xs text-emerald-300/90 line-clamp-1">{goal.outcome_note}</p>}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="absolute top-1 right-1 p-1.5 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/20 transition-colors opacity-0 group-hover:opacity-100"
        aria-label="Delete goal"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function NewGoalModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [pillar, setPillar] = useState<LifePillar>(PILLARS[0]);
  const [statement, setStatement] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!statement.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { data, error: insertError } = await supabase
        .from("goals")
        .insert({ pillar, status: "draft" })
        .select("id")
        .single();
      if (insertError) throw insertError;
      const goalId = data.id as string;
      await callSmartGate({ action: "chat", goal_id: goalId, message: statement.trim() });
      onCreated(goalId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 w-full max-w-md">
        <h2 className="text-lg font-semibold text-slate-100 mb-4">New Goal</h2>

        <label className="text-xs font-medium text-slate-400 mb-2 block">Pillar</label>
        <div className="grid grid-cols-2 gap-2 mb-4">
          {PILLARS.map((p) => {
            const colors = getPillarColor(p);
            const selected = pillar === p;
            return (
              <button
                key={p}
                onClick={() => setPillar(p)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm border transition-colors ${
                  selected ? `${colors.border} ${colors.soft} ${colors.text}` : "border-slate-800 text-slate-400 hover:border-slate-700"
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
                {PILLAR_LABELS[p]}
              </button>
            );
          })}
        </div>

        <label className="text-xs font-medium text-slate-400 mb-2 block">What's the goal, roughly?</label>
        <textarea
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          rows={3}
          placeholder="e.g. I want to get better at running"
          className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-blue-600 mb-4"
        />

        {error && <p className="text-sm text-red-400 mb-3">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !statement.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            Start SMART Gate
          </button>
        </div>
      </div>
    </div>
  );
}

function GoalChat({ goalId, onBack }: { goalId: string; onBack: () => void }) {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [smart, setSmart] = useState<SmartFields>(EMPTY_SMART);
  const [status, setStatus] = useState<string>("draft");
  const [pillar, setPillar] = useState<LifePillar | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const [approach, setApproach] = useState<string | null>(null);
  const [cadenceSessions, setCadenceSessions] = useState<number | null>(null);
  const [cadenceLabel, setCadenceLabel] = useState<string | null>(null);
  const [cadenceConfirmed, setCadenceConfirmed] = useState(false);
  const [researchLoading, setResearchLoading] = useState(false);
  // Which model wrote the latest coach reply (shown under the chat).
  const [coachModel, setCoachModel] = useState<string | null>(null);
  const kickedOffRef = useRef(false);

    useEffect(() => {
    let cancelled = false;

  const loadHistory = async () => {
      setLoading(true);
      try {
        const data = await callSmartGate({ action: "history", goal_id: goalId });
        if (cancelled) return;
        setMessages(data.messages || []);
        setSmart(data.smart || EMPTY_SMART);
        if (typeof data.model === "string") setCoachModel(data.model);
        setStatus(data.status || "draft");

        const loadedStatus = data.status || "draft";
        if (loadedStatus !== "draft" && !kickedOffRef.current) {
          kickedOffRef.current = true;
          setResearchLoading(true);
          callGoalResearch({ action: "kickoff", goal_id: goalId })
            .then((researchData) => {
              if (cancelled) return;
              setMessages(researchData.messages || []);
              setStatus(researchData.goal_status || loadedStatus);
              setApproach(researchData.approach ?? null);
              setCadenceSessions(researchData.cadence_sessions_per_week ?? null);
              setCadenceLabel(researchData.cadence_label ?? null);
              setCadenceConfirmed(Boolean(researchData.cadence_confirmed));
            })
            .catch((err) => {
              if (!cancelled) setError(err instanceof Error ? err.message : "Could not start research.");
            })
            .finally(() => {
              if (!cancelled) setResearchLoading(false);
            });
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load this goal.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadHistory();

    supabase
      .from("goals")
      .select("pillar")
      .eq("id", goalId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data) setPillar(data.pillar as LifePillar);
      });

    return () => {
      cancelled = true;
    };
  }, [goalId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (status === "draft" || kickedOffRef.current) return;
    kickedOffRef.current = true;
    setResearchLoading(true);
    callGoalResearch({ action: "kickoff", goal_id: goalId })
      .then((data) => {
        setMessages(data.messages || []);
        setStatus(data.goal_status || status);
        setApproach(data.approach ?? null);
        setCadenceSessions(data.cadence_sessions_per_week ?? null);
        setCadenceLabel(data.cadence_label ?? null);
        setCadenceConfirmed(Boolean(data.cadence_confirmed));
        if (typeof data.model === "string") setCoachModel(data.model);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Could not start research.");
      })
      .finally(() => setResearchLoading(false));
  }, [status, goalId]); // fires on in-session draft→smart_approved transition (approve button or chat-complete); reopen case handled in loadHistory

  const send = async () => {
    const text = input.trim();
    if (!text || sendingRef.current) return;
    sendingRef.current = true;
    setInput("");
    setSending(true);
    setError(null);
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", content: text, created_at: new Date().toISOString() },
    ]);
    try {
      if (status === "draft") {
        const data = await callSmartGate({ action: "chat", goal_id: goalId, message: text });
        setMessages((prev) => [
          ...prev,
          { id: `local-${Date.now()}-r`, role: "assistant", content: data.reply, created_at: new Date().toISOString() },
        ]);
        setSmart(data.smart || EMPTY_SMART);
        if (data.complete) setStatus("smart_approved");
      } else {
        const data = await callGoalResearch({ action: "chat", goal_id: goalId, message: text });
        setMessages(data.messages || []);
        setStatus(data.goal_status || status);
        setApproach(data.approach ?? null);
        setCadenceSessions(data.cadence_sessions_per_week ?? null);
        setCadenceLabel(data.cadence_label ?? null);
        setCadenceConfirmed(Boolean(data.cadence_confirmed));
        if (typeof data.model === "string") setCoachModel(data.model);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The coach didn't respond. Try again.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const approve = async () => {
    setSending(true);
    try {
      await callSmartGate({ action: "approve", goal_id: goalId });
      setStatus("smart_approved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't approve this goal.");
    } finally {
      setSending(false);
    }
  };

  const allSmartSet = SMART_LABELS.every(({ key }) => smart[key]);
  const colors = pillar ? getPillarColor(pillar) : null;

  return (
    <div className="w-full max-w-3xl mx-auto p-4 md:p-6 flex flex-col h-full">
      <div className="flex items-center gap-3 mb-4">
        <button onClick={onBack} className="text-slate-400 hover:text-slate-200 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-lg font-semibold text-slate-100">SMART Gate</h1>
          {pillar && <span className={`text-xs font-medium ${colors?.text}`}>{PILLAR_LABELS[pillar]}</span>}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {cadenceSessions !== null && (
            <span
              className={`px-2 py-0.5 rounded text-xs font-medium ${
                cadenceConfirmed
                  ? "border border-emerald-600/50 text-emerald-400 bg-emerald-600/10"
                  : "border border-dashed border-slate-600 text-slate-400 bg-slate-800/50"
              }`}
            >
              {cadenceLabel || `${cadenceSessions}x/week`}
            </span>
          )}
          {status === "smart_approved" && (
            <span className="flex items-center gap-1 text-xs font-medium text-emerald-400">
              <CheckCircle2 className="w-4 h-4" />
              SMART approved
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-5 gap-1 mb-4">
        {SMART_LABELS.map(({ key, label }) => (
          <div
            key={key}
            className={`text-center py-2 rounded-md text-[11px] font-medium ${
              smart[key] ? "bg-emerald-600/20 text-emerald-400" : "bg-slate-900 text-slate-600"
            }`}
            title={smart[key] || undefined}
          >
            {label}
          </div>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto border border-slate-800 rounded-lg bg-slate-900/50 p-4 mb-3 min-h-[320px] max-h-[50vh]">
        {loading ? (
          <div className="text-slate-500 text-sm">Loading conversation...</div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[80%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap ${
                  m.role === "user" ? "bg-blue-600 text-white self-end" : "bg-slate-800 text-slate-200 self-start"
                }`}
              >
                {m.content}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-400 mb-2">{error}</p>}
      {(coachModel || messages.some((m) => m.role === "assistant")) && (
        <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {coachModel && <span className="text-[11px] text-slate-500">Last reply by {coachModel}</span>}
          <PlannerFeedback
            kind="coach"
            label="Correct the coach"
            excerpt={[...messages].reverse().find((m) => m.role === "assistant")?.content.slice(0, 500)}
          />
        </div>
      )}

      {status === "draft" || status === "smart_approved" || status === "approach_chosen" || status === "active" ? (
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Answer the coach..."
            disabled={sending || loading || researchLoading}
            className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-blue-600 disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={sending || loading || researchLoading || !input.trim()}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
          {status === "draft" && allSmartSet && (
            <button
              onClick={approve}
              disabled={sending}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              Approve
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between bg-emerald-600/10 border border-emerald-600/30 rounded-lg px-4 py-3">
          <p className="text-sm text-emerald-400">
            {status === "approach_chosen" && approach ? `Approach chosen: ${approach}` : "Approach chosen."}
          </p>
        </div>
      )}

      <GoalCompletionBar goalId={goalId} status={status} onChanged={setStatus} />
      {(status === "active" || status === "complete") && <GoalPlanPanel key={status} goalId={goalId} />}
    </div>
  );
}
