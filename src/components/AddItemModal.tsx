import { useState } from "react";
import { X, CalendarClock, Repeat, CheckSquare, Trash2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { ContextTag, LifePillar, Task, FixedEvent, Habit } from "@/lib/types";
import { CONTEXT_COLORS, PILLARS, PILLAR_LABELS, PILLAR_COLORS } from "@/lib/types";
import { scheduleAutoPush } from "@/lib/gcalSync";
import { formatLocalDate } from "@/lib/recurrence";

type RecurrenceFrequency = "daily" | "weekly" | "monthly";
type MonthlyMode = "day_of_month" | "weekday_of_month";
type EndMode = "never" | "on_date" | "after_count";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_SHORT = ["S", "M", "T", "W", "T", "F", "S"];

function toDateInput(d: Date): string {
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 10);
}

type Tab = "event" | "habit" | "task";

const CONTEXTS: ContextTag[] = ["desk", "home", "phone", "errand", "other"];

/** Now, rounded up to the next 15 minutes — the default "Search Start" for new habits/tasks. */
function nextQuarterHour(from = new Date()): Date {
  const d = new Date(from);
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  const up = Math.ceil(m / 15) * 15;
  d.setMinutes(up);
  return d;
}

/**
 * Default window end: Saturday at the given hour of the week the window starts in,
 * or a day after the start if that Saturday is already too close.
 */
function defaultWindowEnd(start: Date, hour: number): Date {
  const sat = new Date(start);
  const daysToSat = (6 - sat.getDay() + 7) % 7;
  sat.setDate(sat.getDate() + daysToSat);
  sat.setHours(hour, 0, 0, 0);
  if (sat.getTime() - start.getTime() < 2 * 3600 * 1000) return new Date(start.getTime() + 24 * 3600 * 1000);
  return sat;
}

function toLocalInput(d: Date): string {
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 16);
}

function fromLocalInput(s: string): string {
  return new Date(s).toISOString();
}

export interface EditTarget {
  kind: "Fixed Event" | "Habit" | "Task";
  id: string;
  data: FixedEvent | Habit | Task;
}

export function AddItemModal({
  weekStart,
  onClose,
  onSaved,
  editTarget,
  prefillDate,
  onDelete,
}: {
  weekStart: Date;
  onClose: () => void;
  onSaved: () => void;
  editTarget?: EditTarget | null;
  prefillDate?: Date | null;
  /** When provided (edit mode), shows a Delete button that asks for a second tap before running. */
  onDelete?: () => Promise<void>;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function runDelete() {
    if (!onDelete) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't delete this item");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const [tab, setTab] = useState<Tab>(
    editTarget ? (editTarget.kind === "Fixed Event" ? "event" : editTarget.kind === "Habit" ? "habit" : "task") : "event"
  );

  const defaultEventStart = prefillDate ?? new Date(weekStart.getTime() + 8 * 3600 * 1000);
  // New habits/tasks start looking for time from right now (next quarter hour).
  const [defaultSearchStart] = useState(() => nextQuarterHour());
  const defaultEventEnd = prefillDate
    ? new Date(prefillDate.getTime() + 60 * 60 * 1000)
    : new Date(weekStart.getTime() + 9 * 3600 * 1000);

  // Event state
  const [evName, setEvName] = useState(() => {
    if (editTarget?.kind === "Fixed Event") return (editTarget.data as FixedEvent).name;
    return "";
  });
  const [evStart, setEvStart] = useState(() => {
    if (editTarget?.kind === "Fixed Event") return toLocalInput(new Date((editTarget.data as FixedEvent).start_time));
    return toLocalInput(defaultEventStart);
  });
  const [evEnd, setEvEnd] = useState(() => {
    if (editTarget?.kind === "Fixed Event") return toLocalInput(new Date((editTarget.data as FixedEvent).end_time));
    return toLocalInput(defaultEventEnd);
  });
  const [evPillar, setEvPillar] = useState<LifePillar | null>(() => {
    if (editTarget?.kind === "Fixed Event") return (editTarget.data as FixedEvent).pillar ?? null;
    return null;
  });

  // Habit state
  const [habName, setHabName] = useState(() => {
    if (editTarget?.kind === "Habit") return (editTarget.data as Habit).name;
    return "";
  });
  const [habTier, setHabTier] = useState(() => {
    if (editTarget?.kind === "Habit") return (editTarget.data as Habit).tier;
    return 2;
  });
  const [habDur, setHabDur] = useState(() => {
    if (editTarget?.kind === "Habit") return (editTarget.data as Habit).duration_min;
    return 30;
  });
  const [habStart, setHabStart] = useState(() => {
    if (editTarget?.kind === "Habit") return toLocalInput(new Date((editTarget.data as Habit).search_start));
    return toLocalInput(defaultSearchStart);
  });
  const [habEnd, setHabEnd] = useState(() => {
    if (editTarget?.kind === "Habit") return toLocalInput(new Date((editTarget.data as Habit).search_end));
    return toLocalInput(defaultWindowEnd(defaultSearchStart, 20));
  });
  const [habContext, setHabContext] = useState<ContextTag>(() => {
    if (editTarget?.kind === "Habit") return (editTarget.data as Habit).context;
    return "desk";
  });
  const [habPillar, setHabPillar] = useState<LifePillar | null>(() => {
    if (editTarget?.kind === "Habit") return (editTarget.data as Habit).pillar ?? null;
    return null;
  });

  // Task state
  const [taskName, setTaskName] = useState(() => {
    if (editTarget?.kind === "Task") return (editTarget.data as Task).name;
    return "";
  });
  const [taskTier, setTaskTier] = useState(() => {
    if (editTarget?.kind === "Task") return (editTarget.data as Task).tier;
    return 2;
  });
  const [taskDur, setTaskDur] = useState(() => {
    if (editTarget?.kind === "Task") return (editTarget.data as Task).duration_min;
    return 30;
  });
  const [taskStart, setTaskStart] = useState(() => {
    if (editTarget?.kind === "Task") return toLocalInput(new Date((editTarget.data as Task).search_start));
    return toLocalInput(defaultSearchStart);
  });
  const [taskDeadline, setTaskDeadline] = useState(() => {
    if (editTarget?.kind === "Task") return toLocalInput(new Date((editTarget.data as Task).deadline));
    return toLocalInput(defaultWindowEnd(defaultSearchStart, 18));
  });
  const [taskContext, setTaskContext] = useState<ContextTag>(() => {
    if (editTarget?.kind === "Task") return (editTarget.data as Task).context;
    return "desk";
  });
  const [taskPillar, setTaskPillar] = useState<LifePillar | null>(() => {
    if (editTarget?.kind === "Task") return (editTarget.data as Task).pillar ?? null;
    return null;
  });

  // Recurrence state — shared across all tabs, initialized from editTarget if present
  const recSource = editTarget?.data as (FixedEvent | Habit | Task) | undefined;
  const [recEnabled, setRecEnabled] = useState(recSource?.recurrence_enabled ?? false);
  const [recFreq, setRecFreq] = useState<RecurrenceFrequency>((recSource?.recurrence_frequency as RecurrenceFrequency) ?? "weekly");
  const [recInterval, setRecInterval] = useState(recSource?.recurrence_interval ?? 1);
  const [recWeekdays, setRecWeekdays] = useState<number[]>(recSource?.recurrence_weekdays ?? []);
  const [recMonthlyMode, setRecMonthlyMode] = useState<MonthlyMode>((recSource?.recurrence_monthly_mode as MonthlyMode) ?? "day_of_month");
  const [recMonthlyDay, setRecMonthlyDay] = useState(recSource?.recurrence_monthly_day ?? 1);
  const [recMonthlyWeekN, setRecMonthlyWeekN] = useState<number>(recSource?.recurrence_monthly_week_n ?? 1);
  const [recMonthlyWeekday, setRecMonthlyWeekday] = useState(recSource?.recurrence_monthly_weekday ?? 1);
  const [recEndMode, setRecEndMode] = useState<EndMode>((recSource?.recurrence_end_mode as EndMode) ?? "never");
  const [recEndDate, setRecEndDate] = useState(
    recSource?.recurrence_end_date ? toDateInput(new Date(recSource.recurrence_end_date)) : toDateInput(new Date(weekStart.getTime() + 30 * 24 * 3600 * 1000))
  );
  const [recCount, setRecCount] = useState(recSource?.recurrence_count ?? 10);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function buildRecurrencePayload(): Record<string, unknown> {
    if (!recEnabled) {
      return { recurrence_enabled: false };
    }
    return {
      recurrence_enabled: true,
      recurrence_frequency: recFreq,
      recurrence_interval: recInterval,
      recurrence_weekdays: recFreq === "weekly" ? recWeekdays : null,
      recurrence_monthly_mode: recFreq === "monthly" ? recMonthlyMode : null,
      recurrence_monthly_day: recFreq === "monthly" && recMonthlyMode === "day_of_month" ? recMonthlyDay : null,
      recurrence_monthly_week_n: recFreq === "monthly" && recMonthlyMode === "weekday_of_month" ? recMonthlyWeekN : null,
      recurrence_monthly_weekday: recFreq === "monthly" && recMonthlyMode === "weekday_of_month" ? recMonthlyWeekday : null,
      recurrence_end_mode: recEndMode,
      recurrence_end_date: recEndMode === "on_date" ? new Date(recEndDate + "T00:00:00").toISOString() : null,
      recurrence_count: recEndMode === "after_count" ? recCount : null,
    };
  }

  async function save() {
    setSaving(true);
    setError(null);

    try {
      if (tab === "event") {
        if (!evName.trim()) throw new Error("Name is required");
        const start = new Date(evStart);
        const end = new Date(evEnd);
        if (end <= start) throw new Error("End time must be after start time");
        const payload: Record<string, unknown> = {
          name: evName.trim(),
          start_time: fromLocalInput(evStart),
          end_time: fromLocalInput(evEnd),
          pillar: evPillar,
          ...buildRecurrencePayload(),
        };
        if (editTarget?.kind === "Fixed Event") {
          const { error } = await supabase.from("fixed_events").update(payload).eq("id", editTarget.id);
          if (error) throw error;
        } else {
          const { error } = await supabase.from("fixed_events").insert(payload);
          if (error) throw error;
        }
      } else if (tab === "habit") {
        if (!habName.trim()) throw new Error("Name is required");
        const start = new Date(habStart);
        const end = new Date(habEnd);
        if (end <= start) throw new Error("Search end must be after search start");
        const payload: Record<string, unknown> = {
          name: habName.trim(),
          tier: habTier,
          duration_min: habDur,
          search_start: fromLocalInput(habStart),
          search_end: fromLocalInput(habEnd),
          context: habContext,
          pillar: habPillar,
          ...buildRecurrencePayload(),
        };
        if (editTarget?.kind === "Habit") {
          const { error } = await supabase.from("habits").update(payload).eq("id", editTarget.id);
          if (error) throw error;
        } else {
          const { error } = await supabase.from("habits").insert(payload);
          if (error) throw error;
        }
      } else {
        if (!taskName.trim()) throw new Error("Name is required");
        const start = new Date(taskStart);
        const deadline = new Date(taskDeadline);
        if (deadline <= start) throw new Error("Deadline must be after search start");
        const payload: Record<string, unknown> = {
          name: taskName.trim(),
          tier: taskTier,
          duration_min: taskDur,
          search_start: fromLocalInput(taskStart),
          deadline: fromLocalInput(taskDeadline),
          context: taskContext,
          pillar: taskPillar,
          ...buildRecurrencePayload(),
        };
        if (editTarget?.kind === "Task") {
          const { error } = await supabase.from("tasks").update(payload).eq("id", editTarget.id);
          if (error) throw error;
        } else {
          const { error } = await supabase.from("tasks").insert(payload);
          if (error) throw error;
        }
      }
      scheduleAutoPush();
      onSaved();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  const headerLabel = editTarget
    ? `Edit ${editTarget.kind}`
    : "Add to Schedule";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[90vh] overflow-y-auto bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="text-base font-semibold">{headerLabel}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-800">
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        {/* Tabs — hidden when editing an existing item */}
        {!editTarget && (
          <div className="flex px-5 pt-4 gap-1">
            {(
              [
                { id: "event", label: "Fixed Event", icon: CalendarClock },
                { id: "habit", label: "Habit", icon: Repeat },
                { id: "task", label: "Task", icon: CheckSquare },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex-1 flex flex-col items-center gap-1 py-2.5 rounded-lg text-xs font-medium transition-colors ${
                  tab === id
                    ? "bg-blue-600 text-white"
                    : "bg-slate-800 text-slate-400 hover:text-slate-200"
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Form */}
        <div className="p-5 space-y-3">
          {tab === "event" && (
            <>
              <Field label="Event Name">
                <input
                  type="text"
                  value={evName}
                  onChange={(e) => setEvName(e.target.value)}
                  placeholder="e.g. Team standup"
                  className="input"
                />
              </Field>
              <Field label="Start Time">
                <input
                  type="datetime-local"
                  value={evStart}
                  onChange={(e) => setEvStart(e.target.value)}
                  className="input"
                />
              </Field>
              <Field label="End Time">
                <input
                  type="datetime-local"
                  value={evEnd}
                  onChange={(e) => setEvEnd(e.target.value)}
                  className="input"
                />
              </Field>
              <Field label="Pillar">
                <PillarPicker value={evPillar} onChange={setEvPillar} />
              </Field>
              <RecurrenceSection
                enabled={recEnabled}
                onToggle={() => setRecEnabled(!recEnabled)}
                freq={recFreq}
                onFreq={setRecFreq}
                interval={recInterval}
                onInterval={setRecInterval}
                weekdays={recWeekdays}
                onWeekdays={setRecWeekdays}
                monthlyMode={recMonthlyMode}
                onMonthlyMode={setRecMonthlyMode}
                monthlyDay={recMonthlyDay}
                onMonthlyDay={setRecMonthlyDay}
                monthlyWeekN={recMonthlyWeekN}
                onMonthlyWeekN={setRecMonthlyWeekN}
                monthlyWeekday={recMonthlyWeekday}
                onMonthlyWeekday={setRecMonthlyWeekday}
                endMode={recEndMode}
                onEndMode={setRecEndMode}
                endDate={recEndDate}
                onEndDate={setRecEndDate}
                count={recCount}
                onCount={setRecCount}
              />
            </>
          )}

          {tab === "habit" && (
            <>
              <Field label="Habit Name">
                <input
                  type="text"
                  value={habName}
                  onChange={(e) => setHabName(e.target.value)}
                  placeholder="e.g. Morning workout"
                  className="input"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Priority Tier">
                  <select
                    value={habTier}
                    onChange={(e) => setHabTier(Number(e.target.value))}
                    className="input"
                  >
                    <option value={1}>P1 — Critical</option>
                    <option value={2}>P2 — High</option>
                    <option value={3}>P3 — Medium</option>
                    <option value={4}>P4 — Low</option>
                  </select>
                </Field>
                <Field label="Duration (min)">
                  <input
                    type="number"
                    value={habDur}
                    onChange={(e) => setHabDur(Number(e.target.value))}
                    min={5}
                    step={5}
                    className="input"
                  />
                </Field>
              </div>
              <Field label="Search Start (earliest)">
                <input
                  type="datetime-local"
                  value={habStart}
                  onChange={(e) => setHabStart(e.target.value)}
                  className="input"
                />
              </Field>
              <Field label="Search End (latest)">
                <input
                  type="datetime-local"
                  value={habEnd}
                  onChange={(e) => setHabEnd(e.target.value)}
                  className="input"
                />
              </Field>
              <Field label="Context">
                <ContextPicker value={habContext} onChange={setHabContext} />
              </Field>
              <Field label="Pillar">
                <PillarPicker value={habPillar} onChange={setHabPillar} />
              </Field>
              <RecurrenceSection
                enabled={recEnabled}
                onToggle={() => setRecEnabled(!recEnabled)}
                freq={recFreq}
                onFreq={setRecFreq}
                interval={recInterval}
                onInterval={setRecInterval}
                weekdays={recWeekdays}
                onWeekdays={setRecWeekdays}
                monthlyMode={recMonthlyMode}
                onMonthlyMode={setRecMonthlyMode}
                monthlyDay={recMonthlyDay}
                onMonthlyDay={setRecMonthlyDay}
                monthlyWeekN={recMonthlyWeekN}
                onMonthlyWeekN={setRecMonthlyWeekN}
                monthlyWeekday={recMonthlyWeekday}
                onMonthlyWeekday={setRecMonthlyWeekday}
                endMode={recEndMode}
                onEndMode={setRecEndMode}
                endDate={recEndDate}
                onEndDate={setRecEndDate}
                count={recCount}
                onCount={setRecCount}
              />
            </>
          )}

          {tab === "task" && (
            <>
              <Field label="Task Name">
                <input
                  type="text"
                  value={taskName}
                  onChange={(e) => setTaskName(e.target.value)}
                  placeholder="e.g. Review PR #42"
                  className="input"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Priority Tier">
                  <select
                    value={taskTier}
                    onChange={(e) => setTaskTier(Number(e.target.value))}
                    className="input"
                  >
                    <option value={1}>P1 — Critical</option>
                    <option value={2}>P2 — High</option>
                    <option value={3}>P3 — Medium</option>
                    <option value={4}>P4 — Low</option>
                  </select>
                </Field>
                <Field label="Duration (min)">
                  <input
                    type="number"
                    value={taskDur}
                    onChange={(e) => setTaskDur(Number(e.target.value))}
                    min={5}
                    step={5}
                    className="input"
                  />
                </Field>
              </div>
              <Field label="Search Start (earliest)">
                <input
                  type="datetime-local"
                  value={taskStart}
                  onChange={(e) => setTaskStart(e.target.value)}
                  className="input"
                />
              </Field>
              <Field label="Deadline">
                <input
                  type="datetime-local"
                  value={taskDeadline}
                  onChange={(e) => setTaskDeadline(e.target.value)}
                  className="input"
                />
              </Field>
              <Field label="Context">
                <ContextPicker value={taskContext} onChange={setTaskContext} />
              </Field>
              <Field label="Pillar">
                <PillarPicker value={taskPillar} onChange={setTaskPillar} />
              </Field>
              <RecurrenceSection
                enabled={recEnabled}
                onToggle={() => setRecEnabled(!recEnabled)}
                freq={recFreq}
                onFreq={setRecFreq}
                interval={recInterval}
                onInterval={setRecInterval}
                weekdays={recWeekdays}
                onWeekdays={setRecWeekdays}
                monthlyMode={recMonthlyMode}
                onMonthlyMode={setRecMonthlyMode}
                monthlyDay={recMonthlyDay}
                onMonthlyDay={setRecMonthlyDay}
                monthlyWeekN={recMonthlyWeekN}
                onMonthlyWeekN={setRecMonthlyWeekN}
                monthlyWeekday={recMonthlyWeekday}
                onMonthlyWeekday={setRecMonthlyWeekday}
                endMode={recEndMode}
                onEndMode={setRecEndMode}
                endDate={recEndDate}
                onEndDate={setRecEndDate}
                count={recCount}
                onCount={setRecCount}
              />
            </>
          )}

          {error && (
            <div className="text-sm text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-lg bg-slate-800 text-slate-300 text-sm font-medium hover:bg-slate-700 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="flex-1 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 transition-colors disabled:opacity-50"
            >
              {saving ? "Saving…" : editTarget ? "Save Changes" : "Add to Schedule"}
            </button>
          </div>

          {editTarget && onDelete && (
            <button
              onClick={runDelete}
              disabled={deleting || saving}
              className={`w-full py-2.5 rounded-lg border text-sm font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50 ${
                confirmDelete
                  ? "bg-rose-600 border-rose-600 text-white hover:bg-rose-500"
                  : "bg-rose-500/10 border-rose-500/30 text-rose-400 hover:bg-rose-500/20"
              }`}
            >
              <Trash2 className="w-4 h-4" />
              {deleting ? "Deleting…" : confirmDelete ? `Tap again to delete this ${editTarget.kind.toLowerCase()}` : "Delete"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RecurrenceSection({
  enabled, onToggle,
  freq, onFreq,
  interval, onInterval,
  weekdays, onWeekdays,
  monthlyMode, onMonthlyMode,
  monthlyDay, onMonthlyDay,
  monthlyWeekN, onMonthlyWeekN,
  monthlyWeekday, onMonthlyWeekday,
  endMode, onEndMode,
  endDate, onEndDate,
  count, onCount,
}: {
  enabled: boolean;
  onToggle: () => void;
  freq: RecurrenceFrequency;
  onFreq: (f: RecurrenceFrequency) => void;
  interval: number;
  onInterval: (n: number) => void;
  weekdays: number[];
  onWeekdays: (w: number[]) => void;
  monthlyMode: MonthlyMode;
  onMonthlyMode: (m: MonthlyMode) => void;
  monthlyDay: number;
  onMonthlyDay: (n: number) => void;
  monthlyWeekN: number;
  onMonthlyWeekN: (n: number) => void;
  monthlyWeekday: number;
  onMonthlyWeekday: (n: number) => void;
  endMode: EndMode;
  onEndMode: (m: EndMode) => void;
  endDate: string;
  onEndDate: (d: string) => void;
  count: number;
  onCount: (n: number) => void;
}) {
  return (
    <div className="pt-2 border-t border-slate-800">
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs font-medium text-slate-400 cursor-pointer">
          <Repeat className="w-3.5 h-3.5" />
          Repeats
        </label>
        <button
          type="button"
          onClick={onToggle}
          className={`relative w-10 h-5 rounded-full transition-colors ${enabled ? "bg-blue-600" : "bg-slate-700"}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${enabled ? "translate-x-5" : ""}`} />
        </button>
      </div>

      {enabled && (
        <div className="mt-3 space-y-3">
          <div className="flex gap-2">
            {(["daily", "weekly", "monthly"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => onFreq(f)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                  freq === f ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200"
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>Every</span>
            <input
              type="number"
              value={interval}
              onChange={(e) => onInterval(Math.max(1, Number(e.target.value)))}
              min={1}
              max={365}
              className="w-16 input"
            />
            <span>{freq === "daily" ? (interval === 1 ? "day" : "days") : freq === "weekly" ? (interval === 1 ? "week" : "weeks") : (interval === 1 ? "month" : "months")}</span>
          </div>

          {freq === "weekly" && (
            <div className="flex gap-1.5">
              {WEEKDAY_LABELS.map((_, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    if (weekdays.includes(idx)) {
                      onWeekdays(weekdays.filter((d) => d !== idx));
                    } else {
                      onWeekdays([...weekdays, idx].sort((a, b) => a - b));
                    }
                  }}
                  className={`w-8 h-8 rounded-lg text-xs font-medium transition-colors ${
                    weekdays.includes(idx) ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-500 hover:text-slate-300"
                  }`}
                >
                  {WEEKDAY_SHORT[idx]}
                </button>
              ))}
            </div>
          )}

          {freq === "monthly" && (
            <div className="space-y-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onMonthlyMode("day_of_month")}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    monthlyMode === "day_of_month" ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  On day
                </button>
                <button
                  type="button"
                  onClick={() => onMonthlyMode("weekday_of_month")}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    monthlyMode === "weekday_of_month" ? "bg-blue-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  On the
                </button>
              </div>
              {monthlyMode === "day_of_month" ? (
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span>Day</span>
                  <input
                    type="number"
                    value={monthlyDay}
                    onChange={(e) => onMonthlyDay(Math.min(31, Math.max(1, Number(e.target.value))))}
                    min={1}
                    max={31}
                    className="w-16 input"
                  />
                  <span>of the month</span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <select
                    value={monthlyWeekN}
                    onChange={(e) => onMonthlyWeekN(Number(e.target.value))}
                    className="input flex-1"
                  >
                    <option value={1}>First</option>
                    <option value={2}>Second</option>
                    <option value={3}>Third</option>
                    <option value={4}>Fourth</option>
                    <option value={-1}>Last</option>
                  </select>
                  <select
                    value={monthlyWeekday}
                    onChange={(e) => onMonthlyWeekday(Number(e.target.value))}
                    className="input flex-1"
                  >
                    {WEEKDAY_LABELS.map((label, idx) => (
                      <option key={idx} value={idx}>{label}</option>
                    ))}
                  </select>
                  <span>of the month</span>
                </div>
              )}
            </div>
          )}

          {/* Ends section */}
          <div className="pt-2 border-t border-slate-800/50">
            <div className="text-xs font-medium text-slate-400 mb-2">Ends</div>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                <input
                  type="radio"
                  checked={endMode === "never"}
                  onChange={() => onEndMode("never")}
                  className="accent-blue-600"
                />
                Never
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                <input
                  type="radio"
                  checked={endMode === "on_date"}
                  onChange={() => onEndMode("on_date")}
                  className="accent-blue-600"
                />
                On
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => onEndDate(e.target.value)}
                  className="input"
                  disabled={endMode !== "on_date"}
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                <input
                  type="radio"
                  checked={endMode === "after_count"}
                  onChange={() => onEndMode("after_count")}
                  className="accent-blue-600"
                />
                After
                <input
                  type="number"
                  value={count}
                  onChange={(e) => onCount(Math.max(1, Number(e.target.value)))}
                  min={1}
                  className="w-16 input"
                  disabled={endMode !== "after_count"}
                />
                <span>occurrences</span>
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

function ContextPicker({
  value,
  onChange,
}: {
  value: ContextTag;
  onChange: (c: ContextTag) => void;
}) {
  return (
    <div className="flex gap-2 flex-wrap">
      {CONTEXTS.map((c) => {
        const colors = CONTEXT_COLORS[c];
        return (
          <button
            key={c}
            onClick={() => onChange(c)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize border transition-all ${
              value === c
                ? `${colors.bg} text-white border-transparent`
                : "bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600"
            }`}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}

function PillarPicker({
  value,
  onChange,
}: {
  value: LifePillar | null;
  onChange: (p: LifePillar | null) => void;
}) {
  return (
    <div className="flex gap-2 flex-wrap">
      <button
        onClick={() => onChange(null)}
        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
          value === null
            ? "bg-slate-600 text-white border-transparent"
            : "bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600"
        }`}
      >
        Unassigned
      </button>
      {PILLARS.map((p) => {
        const colors = PILLAR_COLORS[p];
        return (
          <button
            key={p}
            onClick={() => onChange(p)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
              value === p
                ? `${colors.bg} ${colors.text} border-transparent`
                : "bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600"
            }`}
          >
            {PILLAR_LABELS[p]}
          </button>
        );
      })}
    </div>
  );
}
