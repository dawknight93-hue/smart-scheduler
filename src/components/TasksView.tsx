import { useEffect, useMemo, useState } from "react";
import {
  CheckSquare,
  Plus,
  Trash2,
  Clock,
  Flag,
  Search,
  X,
  AlertTriangle,
  Check,
  Pencil,
  Repeat,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Task, ContextTag, LifePillar, TaskOccurrence, RecurrenceScope } from "@/lib/types";
import { CONTEXT_COLORS, TIER_LABELS, PILLARS, PILLAR_LABELS, PILLAR_COLORS } from "@/lib/types";
import { AddItemModal, type EditTarget } from "@/components/AddItemModal";
import { deleteFromGoogle, scheduleAutoPush } from "@/lib/gcalSync";
import { parseRecurrenceFromItem, expandRecurrence, formatRecurrenceSummary, formatLocalDate } from "@/lib/recurrence";

type SortKey = "tier" | "deadline" | "name";
type CompletionFilter = "all" | "incomplete" | "completed";

function formatDeadline(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffH = Math.round(diffMs / (1000 * 60 * 60));
  if (diffH < 0) return "Overdue";
  if (diffH < 24) return `in ${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  return `in ${diffD}d`;
}

function isOverdue(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

function getWeekStart(d: Date): Date {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

interface OccurrenceRow {
  taskId: string;
  taskName: string;
  tier: number;
  durationMin: number;
  context: ContextTag;
  pillar: LifePillar | null;
  deadline: string;
  occurrenceDate: string;
  occurrenceCompleted: boolean;
  isRecurring: true;
  recurrenceSummary: string;
}

interface NonRecurringRow {
  task: Task;
  isRecurring: false;
}

type DisplayRow = (OccurrenceRow | NonRecurringRow) & { key: string };

export function TasksView({ weekStart }: { weekStart: Date }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [occurrences, setOccurrences] = useState<TaskOccurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("tier");
  const [filterContext, setFilterContext] = useState<ContextTag | "all">("all");
  const [filterPillar, setFilterPillar] = useState<LifePillar | "all">("all");
  const [filterTier, setFilterTier] = useState<number | "all">("all");
  const [completionFilter, setCompletionFilter] = useState<CompletionFilter>("incomplete");
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [scopeDialog, setScopeDialog] = useState<{ task: Task; occurrenceDate?: string } | null>(null);

  async function loadTasks() {
    setLoading(true);
    const [taskRes, occRes] = await Promise.all([
      supabase.from("tasks").select("*"),
      supabase.from("task_occurrences").select("*"),
    ]);
    setTasks((taskRes.data as Task[]) ?? []);
    setOccurrences((occRes.data as TaskOccurrence[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadTasks();
  }, []);

  async function toggleComplete(task: Task, occurrenceDate?: string, skipScopeDialog = false) {
    if (task.recurrence_enabled && occurrenceDate && !skipScopeDialog) {
      setScopeDialog({ task, occurrenceDate });
      return;
    }

    setTogglingId(occurrenceDate ? `${task.id}--${occurrenceDate}` : task.id);
    const nowIso = new Date().toISOString();

    if (occurrenceDate) {
      const existing = occurrences.find((o) => o.task_id === task.id && o.occurrence_date === occurrenceDate);
      const newCompleted = !existing?.completed;
      if (existing) {
        await supabase.from("task_occurrences").update({
          completed: newCompleted,
          completed_at: newCompleted ? nowIso : null,
        }).eq("id", existing.id);
      } else {
        await supabase.from("task_occurrences").insert({
          task_id: task.id,
          occurrence_date: occurrenceDate,
          completed: newCompleted,
          completed_at: newCompleted ? nowIso : null,
        });
      }
      setOccurrences((prev) => {
        const idx = prev.findIndex((o) => o.task_id === task.id && o.occurrence_date === occurrenceDate);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], completed: newCompleted, completed_at: newCompleted ? nowIso : null };
          return next;
        }
        return [...prev, {
          id: crypto.randomUUID(),
          task_id: task.id,
          occurrence_date: occurrenceDate,
          completed: newCompleted,
          completed_at: newCompleted ? nowIso : null,
          override_start: null,
          override_end: null,
          skipped: false,
        } as TaskOccurrence];
      });
    } else {
      const newCompletedAt = task.completed_at ? null : nowIso;
      await supabase.from("tasks").update({ completed_at: newCompletedAt }).eq("id", task.id);
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, completed_at: newCompletedAt } : t))
      );
    }
    setTogglingId(null);
    scheduleAutoPush();
  }

  async function handleScopedComplete(task: Task, scope: RecurrenceScope, occurrenceDate?: string) {
    if (scope === "this") {
      await toggleComplete(task, occurrenceDate, true);
    } else if (scope === "all") {
      await toggleComplete(task);
    } else if (scope === "following") {
      const occDate = new Date(occurrenceDate! + "T00:00:00");
      const dayBefore = new Date(occDate.getTime() - 24 * 60 * 60 * 1000);
      await supabase.from("tasks").update({
        recurrence_end_mode: "on_date",
        recurrence_end_date: dayBefore.toISOString(),
      }).eq("id", task.id);
      await toggleComplete(task, occurrenceDate, true);
      loadTasks();
    }
  }

  async function deleteTask(id: string) {
    await deleteFromGoogle("Task", id);
    await supabase.from("tasks").delete().eq("id", id);
    loadTasks();
    scheduleAutoPush();
  }

  const displayRows = useMemo<DisplayRow[]>(() => {
    const rows: DisplayRow[] = [];
    const rangeStart = getWeekStart(new Date());
    const rangeEnd = addDays(rangeStart, 28);

    for (const task of tasks) {
      if (task.recurrence_enabled) {
        const rule = parseRecurrenceFromItem(task);
        const summary = formatRecurrenceSummary(rule);
        const startDate = new Date(task.search_start);
        const occDates = expandRecurrence(rule, startDate, rangeStart, rangeEnd);
        if (occDates.length === 0) {
          rows.push({ key: task.id, task, isRecurring: false });
          continue;
        }
        for (const occDate of occDates) {
          const dateStr = formatLocalDate(occDate);
          const occ = occurrences.find((o) => o.task_id === task.id && o.occurrence_date === dateStr);
          if (occ?.skipped) continue;
          rows.push({
            key: `${task.id}--${dateStr}`,
            taskId: task.id,
            taskName: task.name,
            tier: task.tier,
            durationMin: task.duration_min,
            context: task.context,
            pillar: task.pillar ?? null,
            deadline: task.deadline,
            occurrenceDate: dateStr,
            occurrenceCompleted: occ?.completed ?? false,
            isRecurring: true,
            recurrenceSummary: summary,
          });
        }
      } else {
        rows.push({ key: task.id, task, isRecurring: false });
      }
    }
    return rows;
  }, [tasks, occurrences]);

  const filtered = useMemo(() => {
    let list = [...displayRows];

    const isDone = (r: DisplayRow) =>
      r.isRecurring ? r.occurrenceCompleted : !!r.task.completed_at;

    if (completionFilter === "incomplete") list = list.filter((r) => !isDone(r));
    if (completionFilter === "completed") list = list.filter((r) => isDone(r));
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((r) => (r.isRecurring ? r.taskName : r.task.name).toLowerCase().includes(q));
    }
    if (filterContext !== "all") list = list.filter((r) => (r.isRecurring ? r.context : r.task.context) === filterContext);
    if (filterPillar !== "all") list = list.filter((r) => (r.isRecurring ? r.pillar : r.task.pillar ?? null) === filterPillar);
    if (filterTier !== "all") list = list.filter((r) => (r.isRecurring ? r.tier : r.task.tier) === filterTier);

    list.sort((a, b) => {
      const aDeadline = a.isRecurring ? a.deadline : a.task.deadline;
      const bDeadline = b.isRecurring ? b.deadline : b.task.deadline;
      const aTier = a.isRecurring ? a.tier : a.task.tier;
      const bTier = b.isRecurring ? b.tier : b.task.tier;
      const aName = a.isRecurring ? a.taskName : a.task.name;
      const bName = b.isRecurring ? b.taskName : b.task.name;
      if (sortKey === "tier") return aTier - bTier || new Date(aDeadline).getTime() - new Date(bDeadline).getTime();
      if (sortKey === "deadline") return new Date(aDeadline).getTime() - new Date(bDeadline).getTime();
      return aName.localeCompare(bName);
    });
    return list;
  }, [displayRows, search, sortKey, filterContext, filterPillar, filterTier, completionFilter]);

  const incompleteCount = useMemo(() => displayRows.filter((r) => r.isRecurring ? !r.occurrenceCompleted : !r.task.completed_at).length, [displayRows]);
  const completedCount = useMemo(() => displayRows.filter((r) => r.isRecurring ? r.occurrenceCompleted : !!r.task.completed_at).length, [displayRows]);
  const overdueCount = useMemo(
    () => displayRows.filter((r) => {
      const done = r.isRecurring ? r.occurrenceCompleted : !!r.task.completed_at;
      const deadline = r.isRecurring ? r.deadline : r.task.deadline;
      return !done && isOverdue(deadline);
    }).length,
    [displayRows]
  );

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tasks…"
              className="input pl-9"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <select
            value={filterTier}
            onChange={(e) => setFilterTier(e.target.value === "all" ? "all" : Number(e.target.value))}
            className="input w-auto"
          >
            <option value="all">All priorities</option>
            <option value={1}>P1 — Critical</option>
            <option value={2}>P2 — High</option>
            <option value={3}>P3 — Medium</option>
            <option value={4}>P4 — Low</option>
          </select>

          <select
            value={filterContext}
            onChange={(e) => setFilterContext(e.target.value as ContextTag | "all")}
            className="input w-auto capitalize"
          >
            <option value="all">All contexts</option>
            <option value="desk">Desk</option>
            <option value="home">Home</option>
            <option value="phone">Phone</option>
            <option value="errand">Errand</option>
            <option value="other">Other</option>
          </select>

          <select
            value={filterPillar}
            onChange={(e) => setFilterPillar(e.target.value as LifePillar | "all")}
            className="input w-auto"
          >
            <option value="all">All pillars</option>
            {PILLARS.map((p) => (
              <option key={p} value={p}>{PILLAR_LABELS[p]}</option>
            ))}
          </select>

          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="input w-auto"
          >
            <option value="tier">Sort: Priority</option>
            <option value="deadline">Sort: Deadline</option>
            <option value="name">Sort: Name</option>
          </select>

          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-500 transition-colors flex items-center gap-2 shrink-0"
          >
            <Plus className="w-4 h-4" />
            Add Task
          </button>
        </div>

        {/* Completion filter tabs */}
        <div className="flex items-center gap-1 mb-4">
          {(
            [
              { id: "incomplete", label: "Incomplete", count: incompleteCount },
              { id: "completed", label: "Completed", count: completedCount },
              { id: "all", label: "All", count: displayRows.length },
            ] as const
          ).map(({ id, label, count }) => (
            <button
              key={id}
              onClick={() => setCompletionFilter(id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 ${
                completionFilter === id
                  ? "bg-slate-700 text-slate-100"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
              }`}
            >
              {label}
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                completionFilter === id ? "bg-slate-600 text-slate-200" : "bg-slate-800 text-slate-500"
              }`}>
                {count}
              </span>
            </button>
          ))}
        </div>

        {/* Summary bar */}
        <div className="flex items-center gap-4 mb-4 text-xs">
          <span className="text-slate-400">{filtered.length} item{filtered.length !== 1 ? "s" : ""}</span>
          {overdueCount > 0 && (
            <span className="flex items-center gap-1.5 text-rose-400">
              <AlertTriangle className="w-3.5 h-3.5" />
              {overdueCount} overdue
            </span>
          )}
        </div>

        {/* Task list */}
        {loading ? (
          <div className="flex items-center justify-center h-48 text-slate-500">
            <div className="animate-pulse">Loading tasks…</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-slate-500">
            <CheckSquare className="w-10 h-10 mb-3 text-slate-600" />
            <p className="text-sm">
              {displayRows.length === 0
                ? "No tasks yet. Add your first task to get started."
                : completionFilter === "completed"
                ? "No completed tasks yet."
                : completionFilter === "incomplete"
                ? "All tasks are complete."
                : "No tasks match your filters."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((row) => {
              const name = row.isRecurring ? row.taskName : row.task.name;
              const context = row.isRecurring ? row.context : row.task.context;
              const tier = row.isRecurring ? row.tier : row.task.tier;
              const dur = row.isRecurring ? row.durationMin : row.task.duration_min;
              const pillar = row.isRecurring ? row.pillar : (row.task.pillar ?? null);
              const deadline = row.isRecurring ? row.deadline : row.task.deadline;
              const done = row.isRecurring ? row.occurrenceCompleted : !!row.task.completed_at;
              const colors = CONTEXT_COLORS[context];
              const overdue = !done && isOverdue(deadline);
              const toggleId = row.isRecurring ? `${row.taskId}--${row.occurrenceDate}` : row.task.id;
              const taskRef = row.isRecurring ? tasks.find((t) => t.id === row.taskId)! : row.task;

              return (
                <div
                  key={row.key}
                  className={`group flex items-center gap-3 rounded-xl border ${colors.border} ${
                    done ? "bg-slate-800/30" : colors.soft
                  } border-l-4 px-4 py-3 hover:bg-slate-800/40 transition-colors`}
                >
                  {/* Completion checkbox */}
                  <button
                    onClick={() => toggleComplete(taskRef, row.isRecurring ? row.occurrenceDate : undefined)}
                    disabled={togglingId === toggleId}
                    className={`shrink-0 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                      done
                        ? "bg-emerald-500 border-emerald-500"
                        : "border-slate-600 hover:border-emerald-500"
                    } ${togglingId === toggleId ? "opacity-50" : ""}`}
                    aria-label={done ? "Mark as incomplete" : "Mark as complete"}
                  >
                    {done && <Check className="w-3.5 h-3.5 text-white" />}
                  </button>

                  <span className={`w-2.5 h-2.5 rounded-full ${done ? "bg-slate-600" : colors.dot} shrink-0`} />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-medium truncate ${
                        done ? "text-slate-500 line-through" : "text-slate-100"
                      }`}>
                        {name}
                      </span>
                      {row.isRecurring && (
                        <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 shrink-0">
                          <Repeat className="w-2.5 h-2.5" />
                          {row.recurrenceSummary}
                        </span>
                      )}
                      {dur <= 15 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 shrink-0">short</span>
                      )}
                    </div>
                    <div className={`flex items-center gap-3 mt-1 text-xs ${done ? "text-slate-600" : "text-slate-400"}`}>
                      <span className="flex items-center gap-1">
                        <Flag className="w-3 h-3" />
                        {TIER_LABELS[tier]}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {dur}m
                      </span>
                      <span className="capitalize">{context}</span>
                      {pillar && (
                        <span className="flex items-center gap-1">
                          <span className={`w-1.5 h-1.5 rounded-full ${PILLAR_COLORS[pillar].dot}`} />
                          {PILLAR_LABELS[pillar]}
                        </span>
                      )}
                      {row.isRecurring && row.occurrenceDate && (
                        <span className="text-slate-500">
                          {new Date(row.occurrenceDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                      )}
                      {done && !row.isRecurring && row.task.completed_at && (
                        <span className="text-emerald-600">
                          done {new Date(row.task.completed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    {!done && (
                      <span className={`text-xs font-medium ${overdue ? "text-rose-400" : "text-slate-400"}`}>
                        {formatDeadline(deadline)}
                      </span>
                    )}
                    <span className="text-xs text-slate-500 hidden sm:block">
                      {new Date(deadline).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                    </span>
                    <button
                      onClick={() => {
                        if (row.isRecurring) {
                          setEditTarget({ kind: "Task", id: row.taskId, data: taskRef });
                        } else {
                          setEditTarget({ kind: "Task", id: row.task.id, data: row.task });
                        }
                      }}
                      className="p-1.5 rounded-lg text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 transition-colors opacity-0 group-hover:opacity-100"
                      aria-label="Edit task"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    {!row.isRecurring && (
                      <button
                        onClick={() => deleteTask(row.task.id)}
                        className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors opacity-0 group-hover:opacity-100"
                        aria-label="Delete task"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showAdd && (
        <AddItemModal
          weekStart={weekStart}
          onClose={() => setShowAdd(false)}
          onSaved={loadTasks}
        />
      )}
      {editTarget && (
        <AddItemModal
          weekStart={weekStart}
          onClose={() => setEditTarget(null)}
          onSaved={loadTasks}
          editTarget={editTarget}
        />
      )}

      {scopeDialog && (
        <ScopeDialog
          itemName={scopeDialog.task.name}
          occurrenceDate={scopeDialog.occurrenceDate}
          onCancel={() => setScopeDialog(null)}
          onSelect={(scope) => {
            if (scopeDialog.occurrenceDate) {
              handleScopedComplete(scopeDialog.task, scope, scopeDialog.occurrenceDate);
            } else {
              if (scope === "all") {
                toggleComplete(scopeDialog.task);
              }
            }
            setScopeDialog(null);
          }}
        />
      )}
    </div>
  );
}

function ScopeDialog({
  itemName,
  occurrenceDate,
  onCancel,
  onSelect,
}: {
  itemName: string;
  occurrenceDate?: string;
  onCancel: () => void;
  onSelect: (scope: RecurrenceScope) => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-2">Complete recurring task</h3>
        <p className="text-xs text-slate-400 mb-4">{itemName}</p>
        <div className="space-y-2">
          <button
            onClick={() => onSelect("this")}
            className="w-full py-2.5 rounded-lg bg-slate-800 text-slate-200 text-sm font-medium hover:bg-slate-700 transition-colors text-left px-4"
          >
            This event
          </button>
          <button
            onClick={() => onSelect("following")}
            className="w-full py-2.5 rounded-lg bg-slate-800 text-slate-200 text-sm font-medium hover:bg-slate-700 transition-colors text-left px-4"
          >
            This and following events
          </button>
          <button
            onClick={() => onSelect("all")}
            className="w-full py-2.5 rounded-lg bg-slate-800 text-slate-200 text-sm font-medium hover:bg-slate-700 transition-colors text-left px-4"
          >
            All events
          </button>
        </div>
        <button
          onClick={onCancel}
          className="w-full mt-3 py-2.5 rounded-lg bg-slate-800 text-slate-400 text-sm font-medium hover:bg-slate-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
