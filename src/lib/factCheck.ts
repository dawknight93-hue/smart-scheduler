/**
 * Fact-check for the written Briefing summary.
 *
 * The summary may only restate what's in the facts the app computed. Every
 * sentence is checked: each 24-hour time, each calendar date, and each number
 * with a unit (hours, miles, days, %…) must appear in the facts; weather talk
 * needs an airport-weather line; and claims about a current weight are never
 * allowed (the app has no weigh-ins). Sentences that fail are removed, and the
 * reasons are kept so the Briefing can show what was taken out.
 */

export interface Removed {
  sentence: string;
  reasons: string[];
}

export interface FactCheckResult {
  text: string;
  removed: Removed[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

function normMonth(m: string): string {
  const k = m.slice(0, 3).toLowerCase();
  const i = MONTHS.indexOf(k);
  return i >= 0 ? MONTHS[i][0].toUpperCase() + MONTHS[i].slice(1) : m;
}

/** Split into sentences without breaking on "a.m."-style dots or decimals. */
function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(])/)
    .filter(Boolean);
}

export function factCheck(summary: string, facts: string): FactCheckResult {
  const f = facts.replace(/\s+/g, " ");
  const fl = f.toLowerCase();
  const hasWeather = /airport weather:/i.test(f);
  const hasLogged = f.includes("LOGGED NUMBERS") && /latest logged/.test(f);
  const removed: Removed[] = [];
  const kept: string[] = [];

  for (const s of sentences(summary)) {
    const reasons: string[] = [];

    // 24-hour times
    for (const m of s.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) {
      const t = `${m[1].padStart(2, "0")}:${m[2]}`;
      if (!f.includes(t)) reasons.push(`time ${t} isn't in the facts`);
    }

    // Dates: "Sep 30", "September 30", "30 Sep", "30th of September"
    const dates = new Set<string>();
    for (const m of s.matchAll(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi"))) dates.add(`${normMonth(m[1])} ${Number(m[2])}`);
    for (const m of s.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`, "gi"))) dates.add(`${normMonth(m[2])} ${Number(m[1])}`);
    for (const d of dates) if (!f.includes(d)) reasons.push(`date ${d} isn't in the facts`);

    // Numbers with units
    for (const m of s.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:-|‑)?\s*(h|hrs?|hours?|mi|miles?|km|lb|lbs|pounds|%|percent|kt|knots|days?|weeks?|sessions?|runs?|tasks?|flights?)\b/gi)) {
      const n = m[1];
      if (!new RegExp(`(^|[^\\d.])${n.replace(".", "\\.")}([^\\d]|$)`).test(f)) reasons.push(`${m[0]} isn't in the facts`);
    }

    // Weather without an airport-weather line
    if (!hasWeather && /\b(weather|forecast|thunderstorms?|rain|snow|gusts?|visibility|wind(?!\s+down))\b/i.test(s)) reasons.push("mentions weather, but there's no airport weather today");

    // Current-weight claims — only allowed when he's logged numbers (then the
    // number check above makes sure each one is in the facts).
    if (
      !hasLogged &&
      /\d{2,3}(?:\.\d)?\s*(?:lb|lbs|pounds)\b/i.test(s) &&
      /\b(you(?:'|’)?re|you are|you(?:'|’)?ve|currently|now at|down to|you weigh|weighing|weighed in|reached|hit (?:your|the)|already (?:under|below|at)|comfortably (?:under|below)|(?:under|below) (?:the|your)|lost \d)/i.test(s)
    ) {
      reasons.push("claims a current weight — nothing has been logged");
    }

    // Never allowed to claim sessions were completed when the facts say they weren't tracked
    if (fl.includes("was not tracked that week") && /\b(completed|finished|did all|logged all|hit all)\b/i.test(s) && /\bruns?|sessions?\b/i.test(s)) {
      reasons.push("says untracked sessions were completed");
    }

    if (reasons.length) removed.push({ sentence: s, reasons });
    else kept.push(s);
  }
  return { text: kept.join(" "), removed };
}
