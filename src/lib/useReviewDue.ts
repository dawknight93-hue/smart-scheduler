import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { defaultReviewWeek, reviewIsDue } from "./goalPlanning";
import { formatLocalDate } from "./recurrence";
import { getWeekStart } from "./schedulingEngine";

/**
 * True when there's an active, planned goal without a Weekly Review for the
 * week that needs one: next week from Sunday 21:30, otherwise the current week
 * (so a week that was never reviewed still shows up Monday–Saturday).
 */
export function useReviewDue(refreshKey: unknown): boolean {
  const [due, setDue] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const now = new Date();
      const week = reviewIsDue(now) ? defaultReviewWeek(now) : getWeekStart(now);
      const [g, r, m] = await Promise.all([
        supabase.from("goals").select("id").eq("status", "active").not("plan_mode", "is", null),
        supabase.from("goal_week_reviews").select("goal_id, measure_key").eq("week_start", formatLocalDate(week)),
        supabase.from("goal_measures").select("id, goal_id, position, created_at").eq("kind", "effort").eq("status", "active").order("position").order("created_at"),
      ]);
      if (cancelled || g.error || r.error) return;
      const rows = (r.data as { goal_id: string; measure_key: string | null }[]) ?? [];
      const measures = m.error ? [] : ((m.data as { id: string; goal_id: string }[]) ?? []);
      const due = ((g.data as { id: string }[]) ?? []).some((goal) => {
        const mine = measures.filter((x) => x.goal_id === goal.id);
        // No measures: one review per goal, as before.
        if (!mine.length) return !rows.some((x) => x.goal_id === goal.id);
        // Each effort measure is reviewed on its own ('' rows count for the first one).
        return mine.some((x, i) => !rows.some((y) => y.goal_id === goal.id && (y.measure_key === x.id || (i === 0 && !y.measure_key))));
      });
      setDue(due);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return due;
}
