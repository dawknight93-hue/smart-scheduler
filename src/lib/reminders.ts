/**
 * Push reminders: what to send and when.
 *
 * The app plans the next 7 days every time it's opened (and when settings
 * change) and saves the plan to the `reminders` table; the push edge function
 * sends each one when its time comes. Reminders reflect the calendar as it was
 * the last time the app was open.
 *
 *   Morning briefing  — at your morning time: first thing on the calendar,
 *                       how much is on, and the top situational-awareness notes.
 *   Reserve eve       — the day before a reserve day: proffer window opens,
 *                       assignments start posting, and 30 min before confirm-by.
 */
import { supabase } from "./supabase";
import { dailyAwareness, reserveEve } from "./awareness";
import { loadAwarenessRules } from "./awarenessRules";
import { dayLabel, hhmm, loadBriefItems, type BriefItem } from "./briefing";
import { formatLocalDate } from "./recurrence";

export interface ReminderSettings {
  enabled: boolean;
  morning: boolean;
  morning_time: string;
  reserve: boolean;
}

export const DEFAULT_SETTINGS: ReminderSettings = { enabled: true, morning: true, morning_time: "06:00", reserve: true };

export interface PlannedReminder {
  key: string;
  send_at: string;
  title: string;
  body: string;
  url: string;
  kind: "morning" | "proffer" | "assignments" | "confirm";
}

export interface ReminderRow extends PlannedReminder {
  id: string;
  sent_at: string | null;
  status: string | null;
}

const DAYS_AHEAD = 7;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const at = (day: Date, hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h || 0, m || 0);
};
const holdsTime = (i: BriefItem) => i.blocks !== false || !!i.flight;
const clip = (s: string, n = 230) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export async function loadReminderSettings(): Promise<ReminderSettings> {
  const { data } = await supabase.from("reminder_settings").select("enabled, morning, morning_time, reserve").eq("id", 1).maybeSingle();
  return data ? { ...DEFAULT_SETTINGS, ...(data as ReminderSettings) } : DEFAULT_SETTINGS;
}

export async function saveReminderSettings(s: ReminderSettings): Promise<void> {
  const { error } = await supabase.from("reminder_settings").upsert({ id: 1, ...s, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

/** Work out the reminders for the next week (pure: no database access). */
export function planReminders(items: BriefItem[], rules: Parameters<typeof dailyAwareness>[2], now: Date, s: ReminderSettings): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  if (!s.enabled) return out;
  const today = startOfDay(now);
  for (let n = 0; n < DAYS_AHEAD; n++) {
    const day = addDays(today, n);
    const date = formatLocalDate(day);

    if (s.morning && /^\d{1,2}:\d{2}$/.test(s.morning_time)) {
      const when = at(day, s.morning_time);
      if (when > now) {
        const dayEnd = addDays(day, 1);
        const timed = items.filter((i) => !i.allDay && !i.enroute && holdsTime(i) && i.start >= day && i.start < dayEnd);
        const flights = timed.filter((i) => i.flight);
        const parts: string[] = [];
        if (flights.length) parts.push(`Flying: ${flights.map((f) => `${f.flight!.origin}→${f.flight!.destination} ${hhmm(f.start)}`).join(", ")}.`);
        const first = timed.find((i) => i.start >= when) ?? timed[0];
        if (first && !first.flight) parts.push(`First up ${hhmm(first.start)} ${first.name.replace(/^[\s,]+/, "")}.`);
        if (!timed.length) parts.push("Nothing timed on the calendar.");
        else if (timed.length > 1) parts.push(`${timed.length} things today.`);
        const notes = dailyAwareness(items, when, rules).notes.slice(0, 2);
        for (const note of notes) parts.push(note.text);
        out.push({
          key: `morning:${date}`,
          send_at: when.toISOString(),
          title: `Briefing · ${dayLabel(day)}`,
          body: clip(parts.join(" ")),
          url: "/?view=briefing",
          kind: "morning",
        });
      }
    }

    if (s.reserve) {
      const eve = reserveEve(items, day, rules);
      if (eve) {
        const label = dayLabel(eve.reserveDay);
        const assigned = eve.flights.length > 0;
        if (!assigned && eve.proffer && eve.proffer.start > now) {
          out.push({
            key: `proffer:${date}`,
            send_at: eve.proffer.start.toISOString(),
            title: "Proffer window open",
            body: `Airline reserve tomorrow (${label}). Proffer for flying or RAP — the window closes at ${hhmm(eve.proffer.end)}.`,
            url: "/?view=briefing",
            kind: "proffer",
          });
        }
        if (!assigned && eve.lookout && eve.lookout > now) {
          out.push({
            key: `assign:${date}`,
            send_at: eve.lookout.toISOString(),
            title: "Watch for tomorrow's assignment",
            body: `Reserve tomorrow (${label}). Crew Scheduling posts next-day assignments from ${hhmm(eve.lookout)}${eve.confirmBy ? ` — confirm yours before ${hhmm(eve.confirmBy)}` : ""}.`,
            url: "/?view=briefing",
            kind: "assignments",
          });
        }
        if (eve.confirmBy) {
          const when = new Date(eve.confirmBy.getTime() - 30 * 60000);
          if (when > now) {
            out.push({
              key: `confirm:${date}`,
              send_at: when.toISOString(),
              title: "Confirm tomorrow's assignment",
              body: assigned
                ? `Reserve tomorrow (${label}): you're assigned ${eve.flights.map((f) => `${f.flight!.origin}→${f.flight!.destination} ${hhmm(f.start)}`).join(", ")}. Make sure it's confirmed before ${hhmm(eve.confirmBy)}.`
                : `Reserve tomorrow (${label}): confirm your assignment before ${hhmm(eve.confirmBy)}.`,
              url: "/?view=briefing",
              kind: "confirm",
            });
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.send_at.localeCompare(b.send_at));
}

let lastSync = 0;
let inFlight: Promise<number> | null = null;

/**
 * Re-plan the next week and save it. Throttled to once every 5 minutes unless
 * forced. Returns how many reminders are scheduled.
 */
export function syncReminders(force = false): Promise<number> {
  if (inFlight) return inFlight;
  if (!force && Date.now() - lastSync < 5 * 60000) return Promise.resolve(-1);
  inFlight = (async () => {
    try {
      const now = new Date();
      const [settings, rules, items] = await Promise.all([
        loadReminderSettings(),
        loadAwarenessRules(),
        loadBriefItems(startOfDay(now), addDays(startOfDay(now), DAYS_AHEAD + 1)),
      ]);
      const planned = planReminders(items, rules, now, settings);
      const { data: existing, error } = await supabase
        .from("reminders")
        .select("id, key")
        .is("sent_at", null)
        .gt("send_at", now.toISOString());
      if (error) throw new Error(error.message);
      const keep = new Set(planned.map((p) => p.key));
      const stale = ((existing as { id: string; key: string }[]) ?? []).filter((r) => !keep.has(r.key)).map((r) => r.id);
      if (stale.length) await supabase.from("reminders").delete().in("id", stale);
      if (planned.length) {
        // Don't touch reminders that already went out.
        const { data: sentRows } = await supabase.from("reminders").select("key").in("key", planned.map((p) => p.key)).not("sent_at", "is", null);
        const sent = new Set(((sentRows as { key: string }[]) ?? []).map((r) => r.key));
        const rows = planned.filter((p) => !sent.has(p.key)).map((p) => ({ ...p, updated_at: now.toISOString() }));
        if (rows.length) {
          const { error: upErr } = await supabase.from("reminders").upsert(rows, { onConflict: "key" });
          if (upErr) throw new Error(upErr.message);
        }
      }
      lastSync = Date.now();
      return planned.length;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** What's scheduled to go out next (for the Reminders panel). */
export async function upcomingReminders(limit = 20): Promise<ReminderRow[]> {
  const { data } = await supabase
    .from("reminders")
    .select("*")
    .is("sent_at", null)
    .gt("send_at", new Date().toISOString())
    .order("send_at")
    .limit(limit);
  return (data as ReminderRow[]) ?? [];
}

/** The most recent reminders that went out (or were skipped). */
export async function recentReminders(limit = 5): Promise<ReminderRow[]> {
  const { data } = await supabase.from("reminders").select("*").not("sent_at", "is", null).order("send_at", { ascending: false }).limit(limit);
  return (data as ReminderRow[]) ?? [];
}
