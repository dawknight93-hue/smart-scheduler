/** Your effort corrections, remembered by normalized title (see effortKey). */
import { supabase } from "./supabase";
import { effortKey, type Effort } from "./effort";

export async function loadEffortMemory(): Promise<Map<string, Effort>> {
  const { data, error } = await supabase.from("effort_memory").select("key, effort");
  if (error) return new Map();
  return new Map(((data as { key: string; effort: Effort }[]) ?? []).map((r) => [r.key, r.effort]));
}

export async function rememberEffort(name: string, effort: Effort): Promise<void> {
  const key = effortKey(name);
  if (!key) return;
  await supabase.from("effort_memory").upsert({ key, effort, updated_at: new Date().toISOString() }, { onConflict: "key" });
}
