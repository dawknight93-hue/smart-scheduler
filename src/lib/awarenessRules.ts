/**
 * Load / save / seed the awareness rules you edit in the Briefing tab.
 * The defaults below reproduce the rules you gave for reserve days, proffering,
 * assignments, open time, bids, paydays, bills and Jatara's calendar.
 */
import { supabase } from "./supabase";
import type { AwarenessRule } from "./awareness";

export type NewRule = Omit<AwarenessRule, "id">;

export const DEFAULT_RULES: NewRule[] = [
  {
    position: 10, enabled: true, label: "Airline reserve", match: "reserve", source: null, tone: "duty", role: "reserve",
    note: "On reserve today (through {through}) — {flying}.", action: null,
    note_next: "Airline reserve tomorrow ({tomorrow}).",
    action_next: "Proffer for flying or RAP for tomorrow; {proffer}; be on the lookout after {lookout} for tomorrow's assignment and confirm it before {confirm_by}.",
    lead_days: 7, coming_up: "Reserve starts {date}", confirm_by: "20:00", assign_from: "15:00", opens_at: null, closes_at: null,
  },
  {
    position: 20, enabled: true, label: "Proffer window", match: "proffer", source: null, tone: "duty", role: "proffer",
    note: "Proffer window today {start}–{end}.", action: null, note_next: null, action_next: null,
    lead_days: 0, coming_up: null, confirm_by: null, assign_from: null, opens_at: "11:00", closes_at: "15:00",
  },
  {
    position: 30, enabled: true, label: "Next-day assignments", match: "crew scheduling, assignments for the following day", source: null, tone: "duty", role: "assignments",
    note: "Crew Scheduling posts next-day assignments {start}–{end}.", action: null, note_next: null, action_next: null,
    lead_days: 0, coming_up: null, confirm_by: null, assign_from: null, opens_at: null, closes_at: null,
  },
  {
    position: 40, enabled: true, label: "Open time / TTOT", match: "open time, ttot, trip trade", source: null, tone: "duty", role: null,
    note: "{title} opens today{at_time}.", action: "Check open time if you want to pick up or trade a trip.", note_next: null, action_next: null,
    lead_days: 7, coming_up: "{title} opens {date}{at_time}", confirm_by: null, assign_from: null, opens_at: null, closes_at: null,
  },
  {
    position: 50, enabled: true, label: "Bid window", match: "bid window, bid period, bidding", source: null, tone: "duty", role: null,
    note: "{title} is open through {through}.", action: "Get your bid in.", note_next: "{title} opens tomorrow.", action_next: null,
    lead_days: 7, coming_up: "{title} opens {date}", confirm_by: null, assign_from: null, opens_at: null, closes_at: null,
  },
  {
    position: 60, enabled: true, label: "Payday", match: "pay date, payday", source: null, tone: "money", role: null,
    note: "Payday today ({title}).", action: null, note_next: null, action_next: null,
    lead_days: 7, coming_up: "Payday {date}", confirm_by: null, assign_from: null, opens_at: null, closes_at: null,
  },
  {
    position: 70, enabled: true, label: "Bills due", match: "payment due, bill due", source: null, tone: "money", role: null,
    note: "{title} today.", action: "Make sure it's paid.", note_next: "{title} tomorrow.", action_next: "Pay it today if it isn't set to autopay.",
    lead_days: 7, coming_up: "{title} {date}", confirm_by: null, assign_from: null, opens_at: null, closes_at: null,
  },
  {
    position: 80, enabled: true, label: "Jatara's calendar", match: "", source: "jatara", tone: "family", role: null,
    note: "Jatara: {title}{when}.", action: null, note_next: null, action_next: null,
    lead_days: 0, coming_up: null, confirm_by: null, assign_from: null, opens_at: null, closes_at: null,
  },
];

let cache: { at: number; rules: AwarenessRule[] } | null = null;

/** Your rules, in order. Seeds the defaults the first time. */
export async function loadAwarenessRules(force = false): Promise<AwarenessRule[]> {
  if (!force && cache && Date.now() - cache.at < 15000) return cache.rules;
  const { data, error } = await supabase.from("awareness_rules").select("*").order("position");
  if (error) {
    // Table not there yet (or offline): fall back to the defaults so the Briefing still works.
    return DEFAULT_RULES.map((r, i) => ({ ...r, id: `default-${i}` }));
  }
  let rules = (data as AwarenessRule[]) ?? [];
  if (!rules.length) {
    const ins = await supabase.from("awareness_rules").insert(DEFAULT_RULES).select("*");
    rules = ((ins.data as AwarenessRule[]) ?? []).sort((a, b) => a.position - b.position);
  }
  cache = { at: Date.now(), rules };
  return rules;
}

export function clearRulesCache() {
  cache = null;
}

export async function saveRule(rule: AwarenessRule | NewRule & { id?: string }): Promise<AwarenessRule> {
  clearRulesCache();
  const { id, ...rest } = rule as AwarenessRule;
  const q = id && !id.startsWith("default-")
    ? supabase.from("awareness_rules").update({ ...rest, updated_at: new Date().toISOString() }).eq("id", id).select("*").single()
    : supabase.from("awareness_rules").insert(rest).select("*").single();
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data as AwarenessRule;
}

export async function deleteRule(id: string): Promise<void> {
  clearRulesCache();
  const { error } = await supabase.from("awareness_rules").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

export async function resetRules(): Promise<AwarenessRule[]> {
  clearRulesCache();
  const del = await supabase.from("awareness_rules").delete().not("id", "is", null);
  if (del.error) throw new Error(del.error.message);
  return loadAwarenessRules(true);
}
