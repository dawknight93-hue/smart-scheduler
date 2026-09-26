/**
 * Finishing a goal: mark it complete (or reopen it).
 *
 * Completing stops all planning for the goal — future 🎯 sessions come off the
 * calendar (and Google), and it leaves the Weekly Review, Briefing and
 * reminders because those only look at active goals. Measures, logged numbers
 * and checkpoints stay as history.
 */
import { supabase } from "./supabase";
import { deleteFromGoogle } from "./gcalSync";
import { syncReminders } from "./reminders";

export async function completeGoal(goalId: string, note?: string): Promise<{ sessionsRemoved: number }> {
  const now = new Date().toISOString();
  const { data: future } = await supabase.from("habits").select("id").eq("goal_id", goalId).gt("search_start", now);
  const ids = ((future as { id: string }[]) ?? []).map((h) => h.id);
  for (const id of ids) {
    // Remove the Google copy first; a failure there shouldn't block finishing the goal.
    await deleteFromGoogle("Habit", id).catch(() => undefined);
  }
  if (ids.length) {
    const { error } = await supabase.from("habits").delete().in("id", ids);
    if (error) throw new Error(error.message);
  }
  const { error } = await supabase
    .from("goals")
    .update({ status: "complete", completed_at: now, outcome_note: note?.trim() || null, updated_at: now })
    .eq("id", goalId);
  if (error) throw new Error(error.message);
  void syncReminders(true).catch(() => undefined);
  return { sessionsRemoved: ids.length };
}

/** Back to active — the next Weekly Review plans it again. */
export async function reopenGoal(goalId: string): Promise<void> {
  const { error } = await supabase
    .from("goals")
    .update({ status: "active", completed_at: null, updated_at: new Date().toISOString() })
    .eq("id", goalId);
  if (error) throw new Error(error.message);
  void syncReminders(true).catch(() => undefined);
}

export const STATUS_LABELS: Record<string, string> = {
  draft: "In SMART Gate",
  smart_approved: "SMART approved",
  approach_chosen: "Approach chosen",
  cadence_pending: "Waiting on a cadence",
  active: "Active",
  missed: "Deadline passed",
  complete: "Completed",
  abandoned: "Let go",
};
