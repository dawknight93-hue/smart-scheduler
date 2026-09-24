/**
 * Situational awareness for the Briefing tab.
 *
 * Events on info-only calendars (Informational, Jatara's) never hold time, but
 * they matter. Awareness RULES — which you edit in the Briefing tab's rules
 * editor — say how to recognize each kind of event and what to tell you about
 * it. This file applies those rules; nothing here guesses.
 *
 * Template placeholders a rule's wording can use:
 *   {title}      the event title, tidied ("TTOT", "Jet Blue payment due")
 *   {start} {end} {when}   times ("11:00", "15:00", " 11:00–15:00" or " (all day)")
 *   {time} {at_time}       a time written in the title, converted to your time
 *                          ("noon CT (13:00 your time)", " at noon CT (13:00 your time)")
 *   {date} {tomorrow} {through}   day labels ("Thu, Sep 24"; last day of a multi-day event)
 *   Reserve rule only: {flying} {proffer} {lookout} {confirm_by}
 */

export type NoteTone = "duty" | "money" | "family" | "info";
export type RuleRole = "reserve" | "proffer" | "assignments";

export interface AwarenessRule {
  id: string;
  position: number;
  enabled: boolean;
  label: string;
  /** Comma-separated words or phrases; any one found in the title matches. Empty = any title. */
  match: string;
  /** Only events from a calendar whose name contains this (e.g. "jatara"). */
  source: string | null;
  tone: NoteTone;
  role: RuleRole | null;
  /** Shown on the event's day. */
  note: string;
  action: string | null;
  /** Shown the day before (reserve: when tomorrow is a reserve day). */
  note_next: string | null;
  action_next: string | null;
  /** List in "Coming up" this many days ahead (0 = don't). */
  lead_days: number;
  coming_up: string | null;
  /** Reserve rule: confirm tomorrow's assignment by (HH:MM). */
  confirm_by: string | null;
  /** Reserve rule: assignments are posted from (HH:MM) when no Crew Scheduling event is on the calendar. */
  assign_from: string | null;
}

export interface AwareItem {
  name: string;
  start: Date;
  end: Date;
  allDay: boolean;
  blocks?: boolean;
  flight?: { origin: string; destination: string };
  source?: string;
}

export interface AwarenessNote {
  tone: NoteTone;
  text: string;
  action?: string;
  ruleId?: string;
}

export interface Fyi {
  item: AwareItem;
  /** True when no rule matched — the card offers "Add a rule". */
  noRule: boolean;
}

export interface DailyAwareness {
  notes: AwarenessNote[];
  fyi: Fyi[];
  comingUp: string[];
}

const DAY = 24 * 3600 * 1000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const dayLabel = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
export const cleanTitle = (s: string) => s.replace(/^[\s,;:.-]+/, "").replace(/\s+/g, " ").trim();

/** "TTOT OPENS AT NOON CST" → "TTOT"; "Jet Blue Payment Due" → "Jet Blue payment due". */
function tidyTitle(raw: string): string {
  let s = cleanTitle(raw).replace(/\s*\bopens?\s+at\b.*$/i, "");
  if (s === s.toUpperCase()) {
    s = s.replace(/\b([A-Z])([A-Z]+)\b/g, (w, a, b) =>
      w.length <= 4 && !/^(AT|THE|FOR|AND|DUE|DAY|PAY|BID|OPEN|TIME|HOUR|DATE)$/.test(w) ? w : a + b.toLowerCase()
    );
  }
  return s.replace(/\b(Payment|Due|Opens|At|Window|Time|Hour|Open|Date|Day|Bid)\b/g, (w, _m, i) => (i === 0 ? w : w.toLowerCase()));
}

/** A time written in a title, converted to your (Eastern) time: "noon CST" → "noon CT (13:00 your time)". */
function titleTime(name: string): string | null {
  const m = /\b(noon|midnight|(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)\s*(c|e|m|p)(s|d)?t\b|\b(noon|midnight)\b/i.exec(name);
  if (!m) return null;
  const word = (m[1] ?? m[7] ?? "").toLowerCase();
  let h: number;
  let min = 0;
  if (word === "noon") h = 12;
  else if (word === "midnight") h = 0;
  else {
    h = Number(m[2]);
    min = Number(m[3] ?? 0);
    const ap = (m[4] ?? "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  }
  const zone = (m[5] ?? "").toLowerCase();
  const offset = { c: 1, m: 2, p: 3, e: 0 }[zone as "c" | "m" | "p" | "e"];
  const local = word === "noon" ? "noon" : `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  if (offset === undefined || offset === 0) return local;
  return `${local} ${zone.toUpperCase()}T (${String((h + offset) % 24).padStart(2, "0")}:${String(min).padStart(2, "0")} your time)`;
}

function fill(tpl: string | null | undefined, vars: Record<string, string>): string {
  if (!tpl) return "";
  return tpl.replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? "").replace(/\s+([.,;])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

function lastDayOf(i: AwareItem): Date {
  const e = i.end;
  return addDays(startOfDay(e), e.getHours() === 0 && e.getMinutes() === 0 ? -1 : 0);
}

function varsFor(i: AwareItem, day: Date): Record<string, string> {
  const t = titleTime(i.name);
  const last = lastDayOf(i);
  return {
    title: tidyTitle(i.name),
    start: i.allDay ? "" : hhmm(i.start),
    end: i.allDay ? "" : hhmm(i.end),
    when: i.allDay ? " (all day)" : ` ${hhmm(i.start)}–${hhmm(i.end)}`,
    time: t ?? "",
    at_time: t ? ` at ${t}` : "",
    date: dayLabel(day),
    tomorrow: dayLabel(addDays(day, 1)),
    through: last.getTime() === startOfDay(day).getTime() ? "today" : dayLabel(last),
  };
}

// ---------------------------------------------------------------------------
// Matching

export function ruleMatches(rule: AwarenessRule, i: AwareItem): boolean {
  if (!rule.enabled) return false;
  if (rule.source && !(i.source ?? "").toLowerCase().includes(rule.source.toLowerCase())) return false;
  const words = rule.match.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (!words.length) return !!rule.source; // "any title" only makes sense with a calendar filter
  const title = i.name.toLowerCase();
  return words.some((w) => title.includes(w));
}

const isInfo = (i: AwareItem) => i.blocks === false && !i.flight;

function onDay(items: AwareItem[], day: Date) {
  const s = startOfDay(day);
  const e = addDays(s, 1);
  return items.filter((i) => i.start < e && i.end > s);
}

function ruleFor(rules: AwarenessRule[], i: AwareItem): AwarenessRule | null {
  return rules.find((r) => ruleMatches(r, i)) ?? null;
}

const byRole = (rules: AwarenessRule[], role: RuleRole) => rules.find((r) => r.enabled && r.role === role) ?? null;

function reserveOn(items: AwareItem[], day: Date, rule: AwarenessRule | null): AwareItem | null {
  if (!rule) return null;
  return onDay(items, day).find((i) => i.allDay && ruleMatches(rule, i)) ?? null;
}

// ---------------------------------------------------------------------------
// Daily

export function dailyAwareness(items: AwareItem[], now: Date, rules: AwarenessRule[]): DailyAwareness {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const todayItems = onDay(items, today);
  const tomorrowItems = onDay(items, tomorrow);
  const notes: AwarenessNote[] = [];
  const used = new Set<AwareItem>();

  const reserveRule = byRole(rules, "reserve");
  const profferRule = byRole(rules, "proffer");
  const assignRule = byRole(rules, "assignments");
  const resToday = reserveOn(items, today, reserveRule);
  const resTomorrow = reserveOn(items, tomorrow, reserveRule);
  const proffer = profferRule ? todayItems.find((i) => !i.allDay && ruleMatches(profferRule, i)) : undefined;
  const assign = assignRule ? todayItems.find((i) => !i.allDay && ruleMatches(assignRule, i)) : undefined;
  const flightsToday = todayItems.filter((i) => i.flight);
  const flightsTomorrow = tomorrowItems.filter((i) => i.flight);
  const legs = (fs: AwareItem[]) => fs.map((f) => `${f.flight!.origin}→${f.flight!.destination} ${hhmm(f.start)}`).join(", ");

  if (reserveRule) {
    const confirmBy = reserveRule.confirm_by || "20:00";
    const lookout = assign ? hhmm(assign.start) : reserveRule.assign_from || "15:00";
    const profferText = !proffer
      ? "no proffer window on the calendar today"
      : now < proffer.start
        ? `proffering opens at ${hhmm(proffer.start)} and closes at ${hhmm(proffer.end)}`
        : now < proffer.end
          ? `proffering is open now until ${hhmm(proffer.end)}`
          : `proffering closed at ${hhmm(proffer.end)}`;
    if (resToday) {
      used.add(resToday);
      const v = {
        ...varsFor(resToday, today),
        flying: flightsToday.length ? `assigned: ${legs(flightsToday)}` : "no flying assigned today",
        proffer: profferText,
        lookout,
        confirm_by: confirmBy,
      };
      const text = fill(reserveRule.note, v);
      if (text) notes.push({ tone: reserveRule.tone, text, action: fill(reserveRule.action, v) || undefined, ruleId: reserveRule.id });
    }
    if (resTomorrow) {
      used.add(resTomorrow);
      const v = {
        ...varsFor(resTomorrow, tomorrow),
        date: dayLabel(tomorrow),
        tomorrow: dayLabel(tomorrow),
        flying: flightsTomorrow.length ? `assigned: ${legs(flightsTomorrow)}` : "no flying assigned yet",
        proffer: profferText,
        lookout,
        confirm_by: confirmBy,
      };
      if (flightsTomorrow.length) {
        notes.push({ tone: reserveRule.tone, text: `Reserve tomorrow and you're assigned: ${legs(flightsTomorrow)}.`, action: `Make sure it's confirmed before ${confirmBy}.`, ruleId: reserveRule.id });
      } else if (reserveRule.note_next) {
        let action = fill(reserveRule.action_next, v);
        if (action && hhmm(now) >= confirmBy) action += ` It's past ${confirmBy} — make sure tomorrow's assignment is confirmed.`;
        notes.push({ tone: reserveRule.tone, text: fill(reserveRule.note_next, v), action: action || undefined, ruleId: reserveRule.id });
      }
      // With a reserve day tomorrow, the proffer and assignment windows are covered above.
      if (proffer) used.add(proffer);
      if (assign) used.add(assign);
    }
  }

  // Everything else on info-only calendars today: first matching rule wins.
  const fyi: Fyi[] = [];
  for (const i of todayItems.filter(isInfo)) {
    if (used.has(i)) continue;
    const rule = ruleFor(rules, i);
    if (!rule) {
      fyi.push({ item: i, noRule: true });
      continue;
    }
    if (rule.role === "reserve") continue; // handled above
    const v = varsFor(i, today);
    const text = fill(rule.note, v);
    if (text) notes.push({ tone: rule.tone, text, action: fill(rule.action, v) || undefined, ruleId: rule.id });
    else fyi.push({ item: i, noRule: false });
  }

  // Day-before reminders (e.g. "bill due tomorrow") for non-reserve rules.
  for (const i of tomorrowItems.filter(isInfo)) {
    if (startOfDay(i.start).getTime() !== tomorrow.getTime()) continue;
    const rule = ruleFor(rules, i);
    if (!rule || rule.role === "reserve" || !rule.note_next) continue;
    const v = varsFor(i, tomorrow);
    notes.push({ tone: rule.tone, text: fill(rule.note_next, v), action: fill(rule.action_next, v) || undefined, ruleId: rule.id });
  }

  // Coming up
  const comingUp: string[] = [];
  const seen = new Set<string>();
  for (let d = 1; d <= 14; d++) {
    const day = addDays(today, d);
    for (const i of onDay(items, day).filter(isInfo)) {
      if (startOfDay(i.start).getTime() !== day.getTime()) continue;
      const rule = ruleFor(rules, i);
      if (!rule || !rule.coming_up || rule.lead_days < d) continue;
      if (d === 1 && rule.note_next && rule.role !== "reserve") continue; // already a "tomorrow" note above
      if (rule.role === "reserve" && reserveOn(items, addDays(day, -1), reserveRule)) continue; // not a start
      const text = fill(rule.coming_up, varsFor(i, day));
      if (text && !seen.has(text)) {
        seen.add(text);
        comingUp.push(text);
      }
    }
  }
  if (resToday && reserveRule) {
    const last = lastDayOf(resToday);
    if (last > today && last.getTime() - today.getTime() <= 7 * DAY) comingUp.push(`Last reserve day ${dayLabel(last)}`);
  }
  return { notes, fyi, comingUp };
}

// ---------------------------------------------------------------------------
// Duty-day counts (weekly / monthly)

export interface DutyStats {
  days: number;
  flying: number;
  reserve: number;
  reserveFlown: number;
  /** Reserve days with no flying — you count these toward your days off. */
  reserveUnflown: number;
  uta: number;
  /** Days with no flying and no UTA (includes unflown reserve days). */
  off: number;
  /** Days with no flying, no UTA and no reserve at all. */
  clearOff: number;
}

export function dutyStats(items: AwareItem[], from: Date, to: Date, isUta: (d: Date) => boolean, rules: AwarenessRule[]): DutyStats {
  const reserveRule = byRole(rules, "reserve");
  const s: DutyStats = { days: 0, flying: 0, reserve: 0, reserveFlown: 0, reserveUnflown: 0, uta: 0, off: 0, clearOff: 0 };
  for (let d = startOfDay(from); d < to; d = addDays(d, 1)) {
    s.days++;
    const flying = onDay(items, d).some((i) => i.flight);
    const reserve = !!reserveOn(items, d, reserveRule);
    const uta = isUta(d);
    if (flying) s.flying++;
    if (reserve) s.reserve++;
    if (reserve && flying) s.reserveFlown++;
    if (reserve && !flying) s.reserveUnflown++;
    if (uta) s.uta++;
    if (!flying && !uta) s.off++;
    if (!flying && !uta && !reserve) s.clearOff++;
  }
  return s;
}

export function dutySentence(s: DutyStats, past: boolean): string {
  const parts: string[] = [];
  if (s.reserve) {
    parts.push(
      s.reserveFlown === 0
        ? `${s.reserve} reserve day${s.reserve === 1 ? "" : "s"} with no flying`
        : `${s.reserve} reserve day${s.reserve === 1 ? "" : "s"}, ${s.reserveFlown} flown`
    );
  }
  if (s.flying) parts.push(`${s.flying} flying day${s.flying === 1 ? "" : "s"}`);
  else if (!s.reserve) parts.push(past ? "no flying" : "no flying scheduled");
  if (s.uta) parts.push(`${s.uta} UTA day${s.uta === 1 ? "" : "s"}`);
  parts.push(`${s.off} day${s.off === 1 ? "" : "s"} off${s.reserveUnflown ? ` (incl. ${s.reserveUnflown} unflown reserve)` : ""}`);
  return parts.join(" · ");
}

/** "Coming up"-style markers across a period, from rules that list themselves ahead. */
export function periodMarkers(items: AwareItem[], from: Date, to: Date, rules: AwarenessRule[]): { date: Date; text: string }[] {
  const out: { date: Date; text: string }[] = [];
  const seen = new Set<string>();
  for (const i of items.filter(isInfo)) {
    const day = startOfDay(i.start);
    if (day < startOfDay(from) || day >= to) continue;
    const rule = ruleFor(rules, i);
    if (!rule || rule.role || !rule.coming_up || rule.lead_days <= 0) continue;
    // The list shows the date on its own, so leave {date} out of the text.
    const text = fill(rule.coming_up, { ...varsFor(i, day), date: "" });
    const key = `${text}|${day.getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ date: day, text });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Fill a template with sample values (for the editor preview). */
export function previewTemplate(tpl: string | null, role: RuleRole | null): string {
  return fill(tpl, {
    title: "TTOT",
    start: "11:00",
    end: "15:00",
    when: " 11:00–15:00",
    time: "noon CT (13:00 your time)",
    at_time: " at noon CT (13:00 your time)",
    date: "Thu, Sep 24",
    tomorrow: "Fri, Sep 25",
    through: "Sat, Sep 26",
    ...(role === "reserve"
      ? { flying: "no flying assigned today", proffer: "proffering is open now until 15:00", lookout: "15:00", confirm_by: "20:00" }
      : {}),
  });
}
