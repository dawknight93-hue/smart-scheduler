/**
 * Situational awareness for the Briefing tab.
 *
 * Events on info-only calendars (Informational, Jatara's) never hold time, but
 * they matter: reserve days, the proffer window, when Crew Scheduling posts
 * tomorrow's assignment, open-time and bid windows, paydays and bills. This
 * turns them into plain notes with the action they imply, and counts duty days
 * (flying, reserve, UTA, off) for the weekly and monthly look-back.
 *
 * Everything here is rule-based, so the notes are exact; the written summary
 * only rephrases them.
 */

/** Rules you gave for reserve days. Change these if your company's times change. */
export const RESERVE_RULES = {
  /** Confirm the next-day assignment by this time (home time). */
  confirmBy: "20:00",
  /** Crew Scheduling posts next-day assignments from this time if no event says otherwise. */
  assignmentsFrom: "15:00",
};

export interface AwareItem {
  name: string;
  start: Date;
  end: Date;
  allDay: boolean;
  blocks?: boolean;
  flight?: { origin: string; destination: string };
  source?: string;
}

export type NoteTone = "duty" | "money" | "family" | "info";

export interface AwarenessNote {
  tone: NoteTone;
  /** The fact, e.g. "On reserve today (through Sat 26 Sep)". */
  text: string;
  /** What to do about it, if anything. */
  action?: string;
}

const DAY = 24 * 3600 * 1000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const dayLabel = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const clean = (s: string) => s.replace(/^[\s,;:.-]+/, "").replace(/\s+/g, " ").trim();
/** "TTOT OPENS AT NOON" → "TTOT opens at noon"; short all-caps words (TTOT, MIA) stay as acronyms. */
const titleCase = (s: string) => {
  const t = s === s.toUpperCase() ? s.replace(/\b([A-Z])([A-Z]+)\b/g, (w, a, b) => (w.length <= 4 && !/^(AT|THE|FOR|AND|DUE|DAY|PAY|BID|OPEN|TIME|HOUR)$/.test(w) ? w : a + b.toLowerCase())) : s;
  return t.replace(/\b(Payment|Due|Opens|At|Window|Time|Hour|Open)\b/g, (w, _m, i) => (i === 0 ? w : w.toLowerCase()));
};

const onDay = (items: AwareItem[], day: Date) => {
  const s = startOfDay(day);
  const e = addDays(s, 1);
  return items.filter((i) => i.start < e && i.end > s);
};
const isInfo = (i: AwareItem) => i.blocks === false && !i.flight;

// ---------------------------------------------------------------------------
// Recognizers

const RE = {
  reserve: /\breserve\b/i,
  proffer: /\bproffer/i,
  assignments: /crew\s*scheduling|assignments?\s+for\s+the\s+following\s+day/i,
  openTime: /\bopen\s*time\b|\bttot\b|trip\s*trade/i,
  bid: /\bbid(ding)?\s*(window|period|opens|closes)?\b/i,
  pay: /\bpay\s*(date|day)\b|\bpayday\b/i,
  bill: /\b(payment|bill)\s+due\b|\bdue\b.*\bpayment\b/i,
};

/** "noon CST" → { text: "noon CT (13:00 your time)" }. Only for titles that carry a time. */
function titleTime(name: string): string | null {
  const m = /\b(noon|midnight|(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)\s*(c|e|m|p)?(s|d)?t\b|\b(noon|midnight)\b/i.exec(name);
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
  const local = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  if (offset === undefined || offset === 0) return word === "noon" ? "noon" : local;
  const et = `${String((h + offset) % 24).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  return `${word === "noon" ? "noon" : local} ${zone.toUpperCase()}T (${et} your time)`;
}

/** The reserve block (all-day) covering a day, if any. */
function reserveOn(items: AwareItem[], day: Date): AwareItem | null {
  return onDay(items, day).find((i) => i.allDay && RE.reserve.test(i.name)) ?? null;
}

// ---------------------------------------------------------------------------
// Daily notes

export interface DailyAwareness {
  notes: AwarenessNote[];
  /** Info-only items the notes don't already cover (shown as plain FYIs). */
  fyi: AwareItem[];
  /** Notable things in the next few days (paydays, bills, bid windows, reserve start/end). */
  comingUp: string[];
}

export function dailyAwareness(items: AwareItem[], now: Date): DailyAwareness {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const todayItems = onDay(items, today);
  const tomorrowItems = onDay(items, tomorrow);
  const covered = new Set<AwareItem>();
  const notes: AwarenessNote[] = [];

  const resToday = reserveOn(items, today);
  const resTomorrow = reserveOn(items, tomorrow);
  const flightsToday = todayItems.filter((i) => i.flight);
  const flightsTomorrow = tomorrowItems.filter((i) => i.flight);
  const proffer = todayItems.find((i) => !i.allDay && RE.proffer.test(i.name));
  const assign = todayItems.find((i) => !i.allDay && RE.assignments.test(i.name));
  if (resToday) covered.add(resToday);
  if (resTomorrow) covered.add(resTomorrow);
  if (proffer) covered.add(proffer);
  if (assign) covered.add(assign);

  // Reserve today
  if (resToday) {
    const last = addDays(startOfDay(resToday.end), resToday.end.getHours() === 0 && resToday.end.getMinutes() === 0 ? -1 : 0);
    const through = last.getTime() === today.getTime() ? "last reserve day" : `through ${dayLabel(last)}`;
    notes.push({
      tone: "duty",
      text: `On reserve today (${through})${flightsToday.length ? ` — assigned: ${flightsToday.map((f) => `${f.flight!.origin}→${f.flight!.destination} ${hhmm(f.start)}`).join(", ")}` : " — no flying assigned today"}.`,
    });
  }

  // Reserve tomorrow: proffer or RAP, watch for the assignment, confirm it.
  if (resTomorrow && !flightsTomorrow.length) {
    const steps: string[] = [];
    if (proffer) {
      if (now < proffer.start) steps.push(`proffering opens at ${hhmm(proffer.start)} and closes at ${hhmm(proffer.end)}`);
      else if (now < proffer.end) steps.push(`proffering is open now until ${hhmm(proffer.end)}`);
      else steps.push(`proffering closed at ${hhmm(proffer.end)}`);
    }
    const from = assign ? hhmm(assign.start) : RESERVE_RULES.assignmentsFrom;
    if (hhmm(now) >= RESERVE_RULES.confirmBy) steps.push(`tomorrow's assignment should be confirmed by now (deadline ${RESERVE_RULES.confirmBy})`);
    else steps.push(`be on the lookout after ${from} for tomorrow's assignment and confirm it before ${RESERVE_RULES.confirmBy}`);
    notes.push({
      tone: "duty",
      text: `Airline reserve tomorrow (${dayLabel(tomorrow)}).`,
      action: `Proffer for flying or RAP for tomorrow; ${steps.join("; ")}.`,
    });
  } else if (resTomorrow && flightsTomorrow.length) {
    notes.push({
      tone: "duty",
      text: `Reserve tomorrow and you're assigned: ${flightsTomorrow.map((f) => `${f.flight!.origin}→${f.flight!.destination} ${hhmm(f.start)}`).join(", ")}.`,
      action: `Make sure it's confirmed before ${RESERVE_RULES.confirmBy}.`,
    });
  } else if (resToday && !resTomorrow && startOfDay(resToday.end).getTime() !== tomorrow.getTime()) {
    notes.push({ tone: "duty", text: "Reserve ends after today — tomorrow is off reserve." });
  } else if (proffer) {
    notes.push({ tone: "duty", text: `Proffer window today ${hhmm(proffer.start)}–${hhmm(proffer.end)}.` });
  }
  if (assign && !resTomorrow) {
    notes.push({ tone: "duty", text: `Crew Scheduling posts next-day assignments ${hhmm(assign.start)}–${hhmm(assign.end)}.` });
  }

  // Open time / trip trade, bid windows, pay and bills — today
  for (const i of todayItems.filter(isInfo)) {
    if (covered.has(i)) continue;
    const n = clean(i.name);
    const t = titleTime(n);
    if (RE.openTime.test(n)) {
      notes.push({ tone: "duty", text: `${titleCase(n.replace(/\s*opens?\s+at.*$/i, ""))} opens today${t ? ` at ${t}` : ""}.`, action: "Check open time if you want to pick up or trade a trip." });
    } else if (RE.bid.test(n)) {
      const multi = i.allDay && i.end.getTime() - i.start.getTime() > DAY;
      notes.push({ tone: "duty", text: `${titleCase(n)} ${multi ? `is open (through ${dayLabel(addDays(startOfDay(i.end), -1))})` : "today"}.`, action: "Get your bid in." });
    } else if (RE.pay.test(n)) {
      notes.push({ tone: "money", text: `Payday today (${titleCase(n)}).` });
    } else if (RE.bill.test(n)) {
      notes.push({ tone: "money", text: `${titleCase(n)} today.`, action: "Make sure it's paid." });
    } else continue;
    covered.add(i);
  }

  // Jatara's calendar → family awareness
  const family = todayItems.filter((i) => isInfo(i) && !covered.has(i) && /jatara/i.test(i.source ?? ""));
  for (const i of family) {
    covered.add(i);
    notes.push({ tone: "family", text: `Jatara: ${clean(i.name)}${i.allDay ? " (all day)" : ` ${hhmm(i.start)}–${hhmm(i.end)}`}.` });
  }

  const fyi = todayItems.filter((i) => isInfo(i) && !covered.has(i));

  // Coming up (next 7 days, from info-only calendars)
  const comingUp: string[] = [];
  const seen = new Set<string>();
  for (let d = 1; d <= 7; d++) {
    const day = addDays(today, d);
    for (const i of onDay(items, day).filter(isInfo)) {
      const n = clean(i.name);
      const key = `${n}|${startOfDay(i.start).getTime()}`;
      if (seen.has(key) || startOfDay(i.start).getTime() !== day.getTime()) continue;
      seen.add(key);
      if (RE.pay.test(n)) comingUp.push(`Payday ${dayLabel(day)}`);
      else if (RE.bill.test(n)) comingUp.push(`${titleCase(n)} ${dayLabel(day)}`);
      else if (RE.bid.test(n)) comingUp.push(`${titleCase(n)} opens ${dayLabel(day)}`);
      else if (RE.openTime.test(n)) comingUp.push(`${titleCase(n.replace(/\s*opens?\s+at.*$/i, ""))} opens ${dayLabel(day)}${titleTime(n) ? ` at ${titleTime(n)}` : ""}`);
      else if (i.allDay && RE.reserve.test(n) && !reserveOn(items, addDays(day, -1))) comingUp.push(`Reserve starts ${dayLabel(day)}`);
    }
  }
  if (resToday) {
    const lastRes = addDays(startOfDay(resToday.end), -1);
    if (lastRes > today && lastRes.getTime() - today.getTime() <= 7 * DAY) comingUp.push(`Last reserve day ${dayLabel(lastRes)}`);
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

export function dutyStats(items: AwareItem[], from: Date, to: Date, isUta: (d: Date) => boolean): DutyStats {
  const s: DutyStats = { days: 0, flying: 0, reserve: 0, reserveFlown: 0, reserveUnflown: 0, uta: 0, off: 0, clearOff: 0 };
  for (let d = startOfDay(from); d < to; d = addDays(d, 1)) {
    s.days++;
    const flying = onDay(items, d).some((i) => i.flight);
    const reserve = !!reserveOn(items, d);
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

/** One plain sentence about a period's duty days. */
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

/** Info-only items in a period worth listing (paydays, bills, bid and open-time windows). */
export function periodMarkers(items: AwareItem[], from: Date, to: Date): { date: Date; text: string }[] {
  const out: { date: Date; text: string }[] = [];
  const seen = new Set<string>();
  for (const i of items.filter(isInfo)) {
    const day = startOfDay(i.start);
    if (day < startOfDay(from) || day >= to) continue;
    const n = clean(i.name);
    const key = `${n}|${day.getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (RE.pay.test(n)) out.push({ date: day, text: "Payday" });
    else if (RE.bill.test(n)) out.push({ date: day, text: titleCase(n) });
    else if (RE.bid.test(n)) out.push({ date: day, text: `${titleCase(n)} opens` });
    else if (RE.openTime.test(n) && /48|ttot/i.test(n)) out.push({ date: day, text: `${titleCase(n.replace(/\s*opens?\s+at.*$/i, ""))} opens${titleTime(n) ? ` at ${titleTime(n)}` : ""}` });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}
