import type { PlacedItem, CalendarConnection, FixedEvent, Habit, Task } from "./types";
import { supabase } from "./supabase";
import { runEngine, getWeekStart, addDays } from "./schedulingEngine";
import { buildMirrorItems, defaultMirrorWindowStart } from "./googleMirror";

const FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gcal-sync`;

const HEADERS = {
  Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
};

export const SYNC_WEEKS = 6;

export interface PushableItem {
  item: PlacedItem;
  occurrenceWeek: Date;
}

export interface SyncStatus {
  connected: boolean;
  email: string | null;
  recentRuns: {
    id: string;
    direction: string;
    status: string;
    events_pulled: number;
    events_pushed: number;
    error_message: string | null;
    created_at: string;
  }[];
  connections: CalendarConnection[];
}

export interface SyncResult {
  success: boolean;
  created?: number;
  updated?: number;
  deleted?: number;
  unchanged?: number;
  errors?: string[];
  eventsPulled?: number;
  /** App copies removed because the event was deleted in Google or moved to an unconnected calendar. */
  eventsRemoved?: number;
  eventsPushed?: number;
  message?: string;
  email?: string;
  error?: string;
  disconnected?: boolean;
}

export function getOAuthUrl(): string {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) return "";
  const redirectUri = "https://web-app-development-acoa.bolt.host/gcal-callback";
  const scopes = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/userinfo.email",
  ].join(" ");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export function isGoogleConfigured(): boolean {
  return !!import.meta.env.VITE_GOOGLE_CLIENT_ID;
}

const RECONNECT_MESSAGE =
  "Your Google Calendar connection has expired. Open Calendar Connections and tap Reconnect.";

const SCOPE_MESSAGE =
  "Google Calendar access wasn't granted. Open Calendar Connections, tap Reconnect, and on Google's screen tick the Google Calendar checkbox (or Select all).";

function friendlyError(msg: string): string {
  if (msg.includes("invalid_grant")) return RECONNECT_MESSAGE;
  if (msg.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || msg.includes("insufficientPermissions")) return SCOPE_MESSAGE;
  return msg;
}

async function callEdgeFunction(body: Record<string, unknown>): Promise<SyncResult> {
  const resp = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let errorMsg = `Request failed (${resp.status})`;
    try {
      const errData = await resp.json();
      errorMsg = errData.error ?? errorMsg;
    } catch {
      // response wasn't JSON
    }
    return { success: false, error: friendlyError(errorMsg) };
  }

  const data = await resp.json();
  if (data.error) return { success: false, error: friendlyError(data.error) };
  return { success: true, ...data };
}

export async function exchangeOAuthCode(code: string): Promise<SyncResult> {
  return callEdgeFunction({ action: "oauth-exchange", code });
}

export async function pullFromGoogle(
  weekStart: string,
  connections: CalendarConnection[],
  rangeDays: number = 30
): Promise<SyncResult> {
  const conns = connections.map((c) => ({
    id: c.id,
    calendar_id: c.calendar_id,
    role: c.role,
    enabled: c.enabled,
    name: c.name,
  }));
  return callEdgeFunction({ action: "pull", weekStart, rangeDays, connections: conns });
}

export async function pushToGoogle(
  pushable: PushableItem[],
  connections: CalendarConnection[]
): Promise<SyncResult> {
  const items = pushable
    .filter((x) => x.item.kind === "Habit" || x.item.kind === "Task" || x.item.kind === "Enroute")
    .map(({ item: p, occurrenceWeek }) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      tier: p.tier,
      context: p.context,
      start: p.start.toISOString(),
      end: p.end.toISOString(),
      isBatch: p.isBatch,
      memberNames: p.memberNames,
      memberIds: p.memberIds,
      occurrenceWeek: occurrenceWeek.toISOString(),
    }));
  const conns = connections.map((c) => ({
    id: c.id,
    calendar_id: c.calendar_id,
    role: c.role,
    enabled: c.enabled,
    name: c.name,
  }));
  return callEdgeFunction({ action: "push", placedItems: items, connections: conns });
}

export async function getSyncStatus(): Promise<SyncStatus | null> {
  const resp = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ action: "status" }),
  });

  if (!resp.ok) return null;
  return resp.json();
}

/**
 * Save a moved/resized/edited pulled event back to its own Google calendar.
 * Timed: start/end are instants. All-day (allDay=true): start/end are
 * "YYYY-MM-DD" dates, end exclusive (Google's convention).
 */
export async function updateGoogleSourceEvent(
  googleEventId: string,
  calendarId: string,
  start: Date | string,
  end: Date | string,
  allDay = false
): Promise<SyncResult> {
  return callEdgeFunction({
    action: "update-source-event",
    googleEventId,
    calendarId,
    start: typeof start === "string" ? start : start.toISOString(),
    end: typeof end === "string" ? end : end.toISOString(),
    allDay,
  });
}

export async function disconnectGoogle(): Promise<SyncResult> {
  return callEdgeFunction({ action: "disconnect" });
}

export async function deleteFromGoogle(
  itemKind: string,
  itemId: string
): Promise<SyncResult> {
  const itemType =
    itemKind === "Fixed Event" ? "fixed_event" :
    itemKind === "Habit" ? "habit" : "task";
  return callEdgeFunction({ action: "delete", itemType, itemId });
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;

export async function buildMultiWeekPushItems(
  rangeStart: Date,
  weeks: number = SYNC_WEEKS
): Promise<PushableItem[]> {
  const rangeEnd = addDays(rangeStart, weeks * 7);

  const [evRes, habRes, taskRes, ebRes] = await Promise.all([
    supabase
      .from("fixed_events")
      .select("*")
      .gte("start_time", rangeStart.toISOString())
      .lt("start_time", rangeEnd.toISOString()),
    supabase.from("habits").select("*"),
    supabase.from("tasks").select("*"),
    supabase
      .from("enroute_blocks")
      .select("*")
      .gte("end_time", rangeStart.toISOString())
      .lt("start_time", rangeEnd.toISOString()),
  ]);

  const fixedEvents = (evRes.data as FixedEvent[]) ?? [];
  const habits = (habRes.data as Habit[]) ?? [];
  const tasks = (taskRes.data as Task[]) ?? [];
  const enrouteBlocks = (ebRes.data as any[]) ?? [];

  const pushable: PushableItem[] = [];

  for (let w = 0; w < weeks; w++) {
    const weekStart = addDays(rangeStart, w * 7);
    const { placed } = runEngine(weekStart, fixedEvents, habits, tasks);
    for (const p of placed) {
      pushable.push({ item: p, occurrenceWeek: weekStart });
    }
  }

  for (const b of enrouteBlocks) {
    const item: PlacedItem = {
      id: b.id,
      name: `🚗 ${b.name}`,
      kind: "Enroute",
      tier: 0,
      context: "other",
      start: new Date(b.start_time),
      end: new Date(b.end_time),
      pillar: "civ_career",
      room: 0,
      isBatch: false,
      isAllDay: false,
    };
    pushable.push({ item, occurrenceWeek: getWeekStart(item.start) });
  }

  return pushable;
}

/**
 * Make Google Calendar mirror Smart Scheduler: every app-created Fixed Event,
 * Habit, Task (recurring ones as real repeating series) and Enroute block.
 */
// Run mirrors one at a time: an edit-triggered push and a sync-on-open can
// overlap, and two concurrent runs could both create the same event.
let mirrorQueue: Promise<unknown> = Promise.resolve();

export function mirrorToGoogle(connections: CalendarConnection[]): Promise<SyncResult> {
  const run = mirrorQueue.then(() => runMirror(connections));
  mirrorQueue = run.catch(() => undefined);
  return run;
}

async function runMirror(connections: CalendarConnection[]): Promise<SyncResult> {
  const { items, windowStart } = await buildMirrorItems(defaultMirrorWindowStart());
  const conns = connections.map((c) => ({
    id: c.id,
    calendar_id: c.calendar_id,
    role: c.role,
    enabled: c.enabled,
    name: c.name,
  }));
  return callEdgeFunction({ action: "mirror", items, windowStart: windowStart.toISOString(), connections: conns });
}

export async function autoPushToGoogle(): Promise<void> {
  const status = await getSyncStatus();
  if (!status?.connected) return;
  const connections = status.connections as CalendarConnection[];
  const hasTarget = connections.some((c) => c.role === "schedule_target" && c.enabled);
  if (!hasTarget) return;
  await mirrorToGoogle(connections);
}

export function scheduleAutoPush(delay = 2000): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    autoPushToGoogle().catch(() => {});
  }, delay);
}
