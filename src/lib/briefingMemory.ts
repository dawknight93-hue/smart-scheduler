/**
 * Briefing memory: your corrections to the written summary. Every active note
 * goes along with each summary request, so the summary follows them from then on.
 */
import { supabase } from "./supabase";

export interface MemoryNote {
  id: string;
  note: string;
  active: boolean;
  source: "feedback" | "manual" | "seed";
  kind: string | null;
  excerpt: string | null;
  created_at: string;
}

/** The first set, from your Section A test notes. */
const SEED: string[] = [
  "The Daily briefing covers today and tomorrow morning only; leave the rest of the week to the Weekly briefing.",
  "Events from Jatara's calendar are hers — never call them my appointments or my first item.",
  "No weigh-ins are recorded in the app: never state my current weight or how close I am to a weight number.",
  "Call my workouts runs, not weight-loss sessions.",
  "Don't mention weather unless there's airport weather for a flight.",
  "Use the exact event times from the facts, never the time the briefing was generated.",
];

export async function loadMemory(): Promise<MemoryNote[]> {
  const { data, error } = await supabase.from("briefing_memory").select("*").order("created_at");
  if (error) return [];
  let rows = (data as MemoryNote[]) ?? [];
  if (!rows.length) {
    // Seed once per page load, even if two panels ask at the same moment.
    seeded ??= (async () => {
      const ins = await supabase.from("briefing_memory").insert(SEED.map((note) => ({ note, source: "seed" }))).select("*");
      return ((ins.data as MemoryNote[]) ?? []).sort((a, b) => a.created_at.localeCompare(b.created_at));
    })();
    rows = await seeded;
  }
  return rows;
}

let seeded: Promise<MemoryNote[]> | null = null;

export async function addMemory(note: string, source: MemoryNote["source"], kind?: string, excerpt?: string): Promise<MemoryNote> {
  const { data, error } = await supabase
    .from("briefing_memory")
    .insert({ note: note.trim(), source, kind: kind ?? null, excerpt: excerpt?.slice(0, 600) ?? null })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data as MemoryNote;
}

export async function updateMemory(id: string, patch: Partial<Pick<MemoryNote, "note" | "active">>): Promise<void> {
  const { error } = await supabase.from("briefing_memory").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteMemory(id: string): Promise<void> {
  const { error } = await supabase.from("briefing_memory").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
