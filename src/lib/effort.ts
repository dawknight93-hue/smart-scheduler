/**
 * Effort levels and the daily energy curve the scheduler plans around.
 *
 * Every task and habit is Focus, Routine or Light. You never have to say
 * which: the app guesses from the title, context and length, and remembers
 * any correction you make so similar items get the same label next time.
 *
 * Energy (stated by Oshane): highest in the morning, then the afternoon,
 * lowest at night — especially after 20:30.
 */
import type { ContextTag, LifePillar } from "./types";

export type Effort = "focus" | "routine" | "light";
export const EFFORTS: Effort[] = ["focus", "routine", "light"];
export const EFFORT_LABELS: Record<Effort, string> = { focus: "Focus", routine: "Routine", light: "Light" };
export const EFFORT_HINTS: Record<Effort, string> = {
  focus: "Needs your sharpest hours — studying, writing, planning",
  routine: "Needs attention, not your peak — chores, errands, reviews",
  light: "Quick and low-effort — calls, bills, replies",
};

// ---------------------------------------------------------------------------
// Energy bands (home time)

export type EnergyBand = "morning" | "afternoon" | "evening" | "late";
export const BAND_LABELS: Record<EnergyBand, string> = {
  morning: "morning peak",
  afternoon: "afternoon",
  evening: "evening",
  late: "after 20:30",
};

/** Band for a wall-clock time in home time, given as minutes after midnight. */
export function energyBand(minuteOfDay: number): EnergyBand {
  if (minuteOfDay < 12 * 60) return "morning";
  if (minuteOfDay < 17 * 60) return "afternoon";
  if (minuteOfDay < 20 * 60 + 30) return "evening";
  return "late";
}

/** How well each effort level fits each band (higher is better). */
export const BAND_FIT: Record<Effort, Record<EnergyBand, number>> = {
  // Focus work belongs in the morning; the afternoon will do; never late.
  focus: { morning: 30, afternoon: 18, evening: 4, late: -60 },
  // Routine work: afternoon first, so mornings stay free for focus work.
  routine: { morning: 14, afternoon: 22, evening: 12, late: -25 },
  // Light work fills evenings and the low-energy end of the day.
  // Light work leans to the afternoon and evening (calls still need business hours).
  light: { morning: 6, afternoon: 17, evening: 16, late: 12 },
};

// ---------------------------------------------------------------------------
// Guessing

const FOCUS_WORDS = [
  "study", "studying", "write", "writing", "draft", "build", "design", "plan", "planning", "prepare", "prep",
  "lesson", "course", "curriculum", "research", "learn", "learning", "analyze", "analysis", "create", "code",
  "coding", "develop", "practice", "exam", "test", "chair fly", "memorize", "read", "reading", "taxes",
  "outline", "slides", "presentation", "powerpoint", "brief", "strategy", "debrief", "syllabus", "checkride",
];
const LIGHT_WORDS = [
  "call", "text", "email", "reply", "respond", "pay", "bill", "deposit", "order", "buy", "book", "schedule",
  "confirm", "renew", "cancel", "sign", "send", "print", "remind", "check", "submit", "rsvp", "water", "feed",
  "trash", "pick up", "drop off", "venmo", "zelle", "transfer", "download", "update app", "charge",
];
const ROUTINE_WORDS = [
  "clean", "laundry", "wash", "dry", "fold", "cook", "meal prep", "dishes", "vacuum", "mow", "organize",
  "tidy", "grocery", "groceries", "errand", "shop", "workout", "gym", "run", "walk", "stretch", "review", "inbox",
];

function hasWord(text: string, words: string[]): string | null {
  for (const w of words) {
    // Whole words, allowing simple endings: "plan" matches "plans" and "planning", not "planet".
    const re = new RegExp(`(^|[^a-z])${w.replace(/ /g, "\\s+")}(s|es|ed|d|ing|ning|ping)?([^a-z]|$)`, "i");
    if (re.test(text)) return w;
  }
  return null;
}

/** Normalized title used to remember corrections ("Draft IFR Lesson 4" → "draft ifr lesson"). */
export function effortKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join(" ");
}

export interface EffortInput {
  name: string;
  context?: ContextTag | null;
  durationMin: number;
  pillar?: LifePillar | null;
}

export interface EffortGuess {
  effort: Effort;
  why: string;
}

export function guessEffort(item: EffortInput, memory?: Map<string, Effort>): EffortGuess {
  const remembered = memory?.get(effortKey(item.name));
  if (remembered) return { effort: remembered, why: "you set this for a similar item before" };

  const name = item.name.replace(/[^\p{L}\p{N}\s&/-]/gu, " ");
  const focusWord = hasWord(name, FOCUS_WORDS);
  const lightWord = hasWord(name, LIGHT_WORDS);
  const routineWord = hasWord(name, ROUTINE_WORDS);
  const d = item.durationMin;

  if (focusWord && !(lightWord && d <= 20)) return { effort: "focus", why: `"${focusWord}" in the title` };
  if (lightWord && d <= 30) return { effort: "light", why: `"${lightWord}" in the title` };
  if (routineWord) return { effort: "routine", why: `"${routineWord}" in the title` };
  if (d <= 15) return { effort: "light", why: "short (15 min or less)" };
  if (item.context === "phone") return { effort: "light", why: "phone context" };
  if (item.context === "errand") return { effort: "routine", why: "errand" };
  if (item.context === "desk" && d >= 45) return { effort: "focus", why: "45+ minutes at a desk" };
  return { effort: "routine", why: "default" };
}

/** The most demanding of several efforts (for batched tasks). */
export function maxEffort(efforts: Effort[]): Effort {
  if (efforts.includes("focus")) return "focus";
  if (efforts.includes("routine")) return "routine";
  return "light";
}
