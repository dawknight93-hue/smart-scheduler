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
      const [g, r] = await Promise.all([
        supabase.from("goals").select("id").eq("status", "active").not("plan_mode", "is", null),
        supabase.from("goal_week_reviews").select("goal_id").eq("week_start", formatLocalDate(week)),
      ]);
      if (cancelled || g.error || r.error) return;
      const reviewed = new Set(((r.data as { goal_id: string }[]) ?? []).map((x) => x.goal_id));
      setDue(((g.data as { id: string }[]) ?? []).some((x) => !reviewed.has(x.id)));
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return due;
}
