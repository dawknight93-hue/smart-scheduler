/**
 * Big life blocks: stretches of life that compete with goal time (UTA, flying
 * trips, vacation, civilian training, annual tour).
 *
 * A block is found on the calendar by keywords in event titles — only all-day
 * or long (8h+) events count, so "Leave for work @ 11:00" isn't "leave". The
 * 'trips' kind is Flying: every flight leg, plus layovers away from home.
 *
 * Each goal lists the blocks it must avoid (goals.blocked_blocks); the Weekly
 * Review treats those stretches as busy when it proposes that goal's sessions.
 */
import { supabase } from "./supabase";
import type { FixedEvent } from "./types";
import { matchFlight, HOME_BASE } from "./schedulingEngine";

export type BlockKind = "keywords" | "trips";

export interface LifeBlock {
  id?: string;
  key: string;
  label: string;
  kind: BlockKind;
  keywords: string;
  enabled: boolean;
  position: number;
}

export interface BlockRange {
  key: string;
  label: string;
  start: Date;
  end: Date;
}

export const DEFAULT_BLOCKS: LifeBlock[] = [
  { key: "uta", label: "UTA", kind: "keywords", keywords: "uta, drill weekend", enabled: true, position: 10 },
  { key: "flying", label: "Flying", kind: "trips", keywords: "", enabled: true, position: 20 },
  { key: "vacation", label: "Vacation", kind: "keywords", keywords: "vacation, pto, leave", enabled: true, position: 30 },
  { key: "civ_training", label: "Civ Training", kind: "keywords", keywords: "recurrent, recurrent training", enabled: true, position: 40 },
  { key: "annual_tour", label: "Annual Tour", kind: "keywords", keywords: "annual tour, annual training", enabled: true, position: 50 },
];

export async function loadLifeBlocks(): Promise<LifeBlock[]> {
  const { data, error } = await supabase.from("life_blocks").select("*").order("position").order("created_at");
  // Table not there yet (migration pending): work from the starter list.
  if (error || !data?.length) return DEFAULT_BLOCKS;
  return data as LifeBlock[];
}

export async function saveLifeBlock(b: LifeBlock): Promise<LifeBlock> {
  const row = { key: b.key, label: b.label.trim(), kind: b.kind, keywords: b.keywords, enabled: b.enabled, position: b.position, updated_at: new Date().toISOString() };
  const q = b.id
    ? supabase.from("life_blocks").update(row).eq("id", b.id).select("*").single()
    : supabase.from("life_blocks").upsert(row, { onConflict: "key" }).select("*").single();
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data as LifeBlock;
}

export async function deleteLifeBlock(b: LifeBlock): Promise<void> {
  if (!b.id) return;
  const { error } = await supabase.from("life_blocks").delete().eq("id", b.id);
  if (error) throw new Error(error.message);
}

/** A key for a new block, from its name. */
export function blockKey(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || `block_${Date.now()}`;
}

const splitKeywords = (s: string) =>
  s
    .split(",")
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

function matches(title: string, keywords: string[]): boolean {
  const t = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  return keywords.some((k) => t.includes(` ${k.replace(/[^a-z0-9]+/g, " ").trim()} `));
}

const HOUR = 3600000;

/** Local-time span of a calendar event (all-day events are stored at UTC midnights). */
function span(e: FixedEvent): [Date, Date] {
  const s = new Date(e.start_time);
  const en = new Date(e.end_time);
  if (e.is_all_day) {
    return [new Date(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()), new Date(en.getUTCFullYear(), en.getUTCMonth(), en.getUTCDate())];
  }
  return [s, en];
}

/** Every stretch of each enabled block that touches [from, to). */
export function blockRanges(blocks: LifeBlock[], events: FixedEvent[], from: Date, to: Date): BlockRange[] {
  const out: BlockRange[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    if (!b.enabled) continue;
    if (b.kind === "trips") {
      const legs = events
        .filter((e) => !e.is_all_day)
        .map((e) => ({ e, m: matchFlight(e.name) }))
        .filter((x): x is { e: FixedEvent; m: RegExpExecArray } => !!x.m && !seen.has(`${b.key}|${x.e.id}`))
        .map(({ e, m }) => {
          seen.add(`${b.key}|${e.id}`);
          return { origin: m[1], dest: m[2], dep: new Date(e.start_time), arr: new Date(e.end_time) };
        })
        .sort((a, c) => a.dep.getTime() - c.dep.getTime());
      for (let i = 0; i < legs.length; i++) {
        const a = legs[i];
        out.push({ key: b.key, label: b.label, start: a.dep, end: a.arr });
        const nx = legs[i + 1];
        // Ground time away from home between legs (connections and layovers) is part of the trip.
        if (nx && a.dest !== HOME_BASE && nx.origin === a.dest && nx.dep > a.arr && nx.dep.getTime() - a.arr.getTime() < 4 * 24 * HOUR) {
          out.push({ key: b.key, label: b.label, start: a.arr, end: nx.dep });
        }
      }
      continue;
    }
    const kws = splitKeywords(b.keywords);
    if (!kws.length) continue;
    for (const e of events) {
      const [s, en] = span(e);
      const long = e.is_all_day || en.getTime() - s.getTime() >= 8 * HOUR;
      if (!long || !matches(e.name, kws)) continue;
      out.push({ key: b.key, label: b.label, start: s, end: en });
    }
  }
  return out.filter((r) => r.start < to && r.end > from);
}

/** The blocks a goal must avoid, as busy events for the scheduler. */
export function blockedBusy(ranges: BlockRange[], blocked: string[] | null | undefined): FixedEvent[] {
  if (!blocked?.length) return [];
  return ranges
    .filter((r) => blocked.includes(r.key))
    .map((r, i) => ({ id: `block-${r.key}-${i}-${r.start.getTime()}`, name: r.label, start_time: r.start.toISOString(), end_time: r.end.toISOString() }));
}
