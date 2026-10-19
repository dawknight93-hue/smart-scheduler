import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// This copy's home time zone (app_settings), read at the start of each request.
let HOME_TIME_ZONE = "America/New_York";
async function loadHomeTimeZone() {
  const { data } = await supabase.from("app_settings").select("settings").eq("id", 1).maybeSingle();
  const tz = (data?.settings as { homeTimeZone?: string } | undefined)?.homeTimeZone;
  if (tz) HOME_TIME_ZONE = tz;
}
const GOOGLE_EVENTS_URL = (calendarId: string) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);
type LifePillar =
  | "spiritual"
  | "family"
  | "mil_career"
  | "civ_career"
  | "financial"
  | "physical"
  | "mental";

const VALID_PILLARS: LifePillar[] = [
  "spiritual",
  "family",
  "mil_career",
  "civ_career",
  "financial",
  "physical",
  "mental",
];

const PILLAR_KEYWORDS: Record<LifePillar, string[]> = {
  spiritual: ["church", "bible", "worship", "sermon", "mass", "prayer"],
  family: ["soccer", "recital", "pediatric", "park date", "family time", "daughter", "field trip"],
  mil_career: ["reserve duty", "drill weekend", "annual training", "utm", "orderly room"],
  civ_career: ["envoy", "captain", "recurrent training", "checkride", "layover", "weather brief", "airspace"],
  financial: ["budget", "invoice", "mortgage", "bill pay", "tax filing"],
  physical: ["gym", "workout", "cardio", "strength training", "pt test", "2-mile", "2 mile", "5k"],
  mental: ["therapy", "counseling", "aa meeting", "game night", "gaming"],
};

const FLIGHT_LEG_PATTERN = /([A-Z]{3})\u200b?\s*(?:\u2192|->)\s*\u200b?([A-Z]{3})/;

function guessPillarFromTitle(title: string): LifePillar | null {
  const lower = title.toLowerCase();
  if (FLIGHT_LEG_PATTERN.test(title) || lower.includes("enroute")) return "civ_career";
  if (lower.trim() === "uta") return "mil_career";
  for (const pillar of VALID_PILLARS) {
    if (PILLAR_KEYWORDS[pillar].some((kw) => lower.includes(kw))) return pillar;
  }
  return null;
}

async function categorizePillarViaGroq(title: string): Promise<LifePillar | null> {
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) return null;
  try {
    const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "Classify a calendar event title into exactly one life pillar, or null if genuinely unclear. Pillars: spiritual (church, bible study, worship), family (kids' appointments, practices, family time), mil_career (military reserve duty, UTA, drill), civ_career (airline captain work, flights, trip prep, sim/training), financial (budgeting, bills, taxes), physical (workouts, running, gym, PT test), mental (therapy, counseling, gaming/relaxation). Respond with a single JSON object of the exact shape {\"pillar\": \"spiritual\"} using one of those seven values, or {\"pillar\": null} if truly unclear.",
          },
          { role: "user", content: title },
        ],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);
    return VALID_PILLARS.includes(parsed.pillar) ? parsed.pillar : null;
  } catch {
    return null;
  }
}

async function resolvePillarForNewEvent(title: string): Promise<LifePillar | null> {
  const guess = guessPillarFromTitle(title);
  if (guess) return guess;
  return await categorizePillarViaGroq(title);
}


interface SyncRequest {
  action: "oauth-exchange" | "pull" | "push" | "mirror" | "status" | "disconnect" | "delete" | "update-source-event" | "background-pull" | "list-calendars" | "create-calendar" | "strava-exchange" | "strava-status" | "strava-sync" | "strava-disconnect";
  /** create-calendar: the new calendar's name and time zone. */
  calendarName?: string;
  timeZone?: string;
  code?: string;
  weekStart?: string;
  rangeDays?: number;
  placedItems?: PlacedItemForPush[];
  connections?: { id: string; calendar_id: string; role: string; enabled: boolean; name: string }[];
  itemType?: string;
  itemId?: string;
  items?: MirrorItem[];
  windowStart?: string;
  googleEventId?: string;
  calendarId?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  busy?: boolean;
}

interface PlacedItemForPush {
  id: string;
  name: string;
  kind: string;
  tier: number;
  context: string;
  start: string;
  end: string;
  isBatch: boolean;
  memberNames?: string[];
  memberIds?: string[];
  occurrenceWeek: string;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
  organizer?: { email?: string; self?: boolean };
  guestsCanModify?: boolean;
  locked?: boolean;
  /** "transparent" = shown as Free in Google; "opaque" (or missing) = Busy. */
  transparency?: string;
}

/**
 * Whether Google would let you change this event's time, from what Google
 * publishes: the calendar's accessRole, the event's locked flag, and — for
 * events organized by someone else — guestsCanModify.
 */
function googleCanEdit(accessRole: string | undefined, ev: GoogleEvent): boolean {
  const calendarWritable = !accessRole || accessRole === "owner" || accessRole === "writer";
  if (!calendarWritable) return false;
  if (ev.locked) return false;
  if (ev.organizer && ev.organizer.self === false && !ev.guestsCanModify) return false;
  return true;
}

// ---- Google Calendar mirror -------------------------------------------------
// Everything the app writes to Google is tagged with private extended
// properties: ssMirror=1 (owned by Smart Scheduler), ssKey (stable identity of
// the app item) and ssHash (content hash). The mirror action reconciles Google
// against the full desired list sent by the app, and only ever touches events
// carrying ssMirror=1 — events you create in Google are never modified.

interface MirrorException {
  originalStart?: string;
  originalDate?: string;
  skipped: boolean;
  completed: boolean;
  overrideStart?: string;
  overrideEnd?: string;
}

interface MirrorItem {
  key: string;
  target: "personal" | "tasks" | "habits";
  summary: string;
  description: string;
  colorId?: string;
  allDay: boolean;
  start: string;
  end: string;
  timeZone: string;
  recurrence?: string[];
  exceptions?: MirrorException[];
  hash: string;
}

type MirrorConnection = { calendar_id: string; role: string; enabled: boolean; name: string };

const DAY_MS = 24 * 60 * 60 * 1000;

async function googleJson(url: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/** Google's reply when the sign-in didn't include calendar access (a box left unticked on its consent screen). */
const NO_CALENDAR_ACCESS =
  "Google didn't give this app access to your calendars. Open Settings → Calendars, press Reconnect, and tick the calendar box on Google's screen.";
function googleFailure(prefix: string, status: number, text: string): Error {
  if (status === 403 && /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(text)) {
    return new Error(NO_CALENDAR_ACCESS);
  }
  return new Error(`${prefix} (${status}): ${text}`);
}

async function listMirrorEvents(accessToken: string, calendarId: string): Promise<GoogleEvent[]> {
  const out: GoogleEvent[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(GOOGLE_EVENTS_URL(calendarId));
    url.searchParams.set("privateExtendedProperty", "ssMirror=1");
    url.searchParams.set("singleEvents", "false");
    url.searchParams.set("showDeleted", "false");
    url.searchParams.set("maxResults", "2500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const resp = await googleJson(url.toString(), accessToken);
    if (!resp.ok) {
      throw googleFailure(`Failed to list Smart Scheduler events on ${calendarId}`, resp.status, await resp.text());
    }
    const data = await resp.json();
    out.push(...((data.items ?? []) as GoogleEvent[]));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

function mirrorTime(allDay: boolean, value: string, timeZone: string) {
  return allDay ? { date: value } : { dateTime: value, timeZone };
}

function mirrorBody(item: MirrorItem): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: item.summary,
    description: item.description,
    start: mirrorTime(item.allDay, item.start, item.timeZone),
    end: mirrorTime(item.allDay, item.end, item.timeZone),
    extendedProperties: { private: { ssMirror: "1", ssKey: item.key, ssHash: item.hash } },
  };
  if (item.colorId) body.colorId = item.colorId;
  if (item.recurrence && item.recurrence.length > 0) body.recurrence = item.recurrence;
  return body;
}

async function deleteGoogleEvent(accessToken: string, calendarId: string, eventId: string): Promise<boolean> {
  const resp = await googleJson(`${GOOGLE_EVENTS_URL(calendarId)}/${encodeURIComponent(eventId)}`, accessToken, {
    method: "DELETE",
  });
  return resp.ok || resp.status === 404 || resp.status === 410;
}

async function applyMirrorExceptions(
  accessToken: string,
  calendarId: string,
  masterId: string,
  item: MirrorItem,
  errors: string[]
) {
  const exceptions = item.exceptions ?? [];
  if (exceptions.length === 0) return;
  const times = exceptions.map((e) =>
    e.originalStart ? new Date(e.originalStart).getTime() : new Date(`${e.originalDate}T00:00:00Z`).getTime()
  );
  const instances: GoogleEvent[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${GOOGLE_EVENTS_URL(calendarId)}/${encodeURIComponent(masterId)}/instances`);
    url.searchParams.set("timeMin", new Date(Math.min(...times) - 2 * DAY_MS).toISOString());
    url.searchParams.set("timeMax", new Date(Math.max(...times) + 2 * DAY_MS).toISOString());
    url.searchParams.set("maxResults", "2500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const resp = await googleJson(url.toString(), accessToken);
    if (!resp.ok) {
      errors.push(`${item.summary}: could not read occurrences (${resp.status})`);
      return;
    }
    const data = await resp.json();
    instances.push(...((data.items ?? []) as GoogleEvent[]));
    pageToken = data.nextPageToken;
  } while (pageToken);

  for (const ex of exceptions) {
    const inst = instances.find((i) =>
      ex.originalStart
        ? !!i.originalStartTime?.dateTime &&
          new Date(i.originalStartTime.dateTime).getTime() === new Date(ex.originalStart).getTime()
        : i.originalStartTime?.date === ex.originalDate
    );
    if (!inst) continue;
    const instUrl = `${GOOGLE_EVENTS_URL(calendarId)}/${encodeURIComponent(inst.id)}`;
    if (ex.skipped) {
      await googleJson(instUrl, accessToken, { method: "DELETE" });
      continue;
    }
    const patch: Record<string, unknown> = {};
    if (ex.completed) patch.summary = `✓ ${item.summary}`;
    if (ex.overrideStart && ex.overrideEnd) {
      patch.start = { dateTime: ex.overrideStart, timeZone: item.timeZone };
      patch.end = { dateTime: ex.overrideEnd, timeZone: item.timeZone };
    }
    if (Object.keys(patch).length === 0) continue;
    const resp = await googleJson(instUrl, accessToken, { method: "PATCH", body: JSON.stringify(patch) });
    if (!resp.ok) errors.push(`${item.summary}: could not update one occurrence (${resp.status})`);
  }
}

async function mirrorEvents(connections: MirrorConnection[], items: MirrorItem[], windowStart: string) {
  const accessToken = await getValidAccessToken();
  const enabled = connections.filter((c) => c.enabled && c.calendar_id);
  const targets = enabled.filter((c) => c.role === "schedule_target");
  if (targets.length === 0) {
    return { created: 0, updated: 0, deleted: 0, unchanged: 0, message: "No enabled Write target calendar configured." };
  }
  const tasksCal = targets.find((c) => /task/i.test(c.name)) ?? targets[0];
  const habitsCal = targets.find((c) => /habit/i.test(c.name)) ?? targets[0];
  // Only calendars you chose to write to: a read-only "Family" calendar is never written to.
  const personalCal = targets.find((c) => /personal|family/i.test(c.name)) ?? tasksCal;
  const calFor = (t: MirrorItem["target"]) => (t === "personal" ? personalCal : t === "habits" ? habitsCal : tasksCal);
  const windowStartDt = new Date(windowStart);
  const errors: string[] = [];

  // 1) Retire events written by the old one-way push (tracked only in
  //    gcal_event_map, not tagged). Future ones are replaced by mirror events;
  //    past ones are left alone as history.
  let legacyRemoved = 0;
  const { data: legacy } = await supabase
    .from("gcal_event_map")
    .select("id, google_event_id, calendar_id")
    .eq("calendar_role", "schedule_target")
    .gte("start_time", windowStartDt.toISOString());
  for (const row of legacy ?? []) {
    if (await deleteGoogleEvent(accessToken, row.calendar_id, row.google_event_id)) {
      await supabase.from("gcal_event_map").delete().eq("id", row.id);
      legacyRemoved++;
    }
  }

  // 2) What the app already owns in Google, by key.
  let deleted = 0;
  const existing = new Map<string, { calendarId: string; ev: GoogleEvent }>();
  const calendarIds = [...new Set([tasksCal, habitsCal, personalCal].map((c) => c.calendar_id))];
  for (const calendarId of calendarIds) {
    for (const ev of await listMirrorEvents(accessToken, calendarId)) {
      const key = ev.extendedProperties?.private?.ssKey;
      if (!key) continue;
      if (existing.has(key)) {
        if (await deleteGoogleEvent(accessToken, calendarId, ev.id)) deleted++;
        continue;
      }
      existing.set(key, { calendarId, ev });
    }
  }

  // 3) Create / update everything the app wants shown.
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const desiredKeys = new Set(items.map((i) => i.key));
  for (const item of items) {
    const cal = calFor(item.target);
    const cur = existing.get(item.key);
    if (cur && cur.calendarId === cal.calendar_id && cur.ev.extendedProperties?.private?.ssHash === item.hash) {
      unchanged++;
      continue;
    }
    if (cur && cur.calendarId === cal.calendar_id && !item.recurrence) {
      const resp = await googleJson(
        `${GOOGLE_EVENTS_URL(cal.calendar_id)}/${encodeURIComponent(cur.ev.id)}`,
        accessToken,
        { method: "PUT", body: JSON.stringify(mirrorBody(item)) }
      );
      if (resp.ok) updated++;
      else errors.push(`${item.summary}: update failed (${resp.status}) ${(await resp.text()).slice(0, 200)}`);
      continue;
    }
    // Series (or an item that moved calendars) are rebuilt from scratch so the
    // rule and every one-off exception stay exactly in step with the app.
    if (cur) {
      if (await deleteGoogleEvent(accessToken, cur.calendarId, cur.ev.id)) deleted++;
    }
    const resp = await googleJson(GOOGLE_EVENTS_URL(cal.calendar_id), accessToken, {
      method: "POST",
      body: JSON.stringify(mirrorBody(item)),
    });
    if (!resp.ok) {
      errors.push(`${item.summary}: create failed (${resp.status}) ${(await resp.text()).slice(0, 200)}`);
      continue;
    }
    const createdEv = (await resp.json()) as GoogleEvent;
    if (cur) updated++;
    else created++;
    if (item.recurrence) await applyMirrorExceptions(accessToken, cal.calendar_id, createdEv.id, item, errors);
  }

  // 4) Remove what the app no longer has. Past one-off events are kept as history.
  for (const [key, { calendarId, ev }] of existing) {
    if (desiredKeys.has(key)) continue;
    const endRaw = ev.end?.dateTime ?? ev.end?.date;
    if (!key.startsWith("series:") && endRaw && new Date(endRaw) < windowStartDt) continue;
    if (await deleteGoogleEvent(accessToken, calendarId, ev.id)) deleted++;
  }

  for (const calendarId of calendarIds) {
    await supabase
      .from("calendar_connections")
      .update({ last_synced_at: new Date().toISOString(), last_sync_error: errors.length ? errors[0] : null })
      .eq("calendar_id", calendarId);
  }

  return {
    created,
    updated,
    deleted,
    unchanged,
    legacyRemoved,
    errors,
    eventsPushed: created + updated,
    calendars: { personal: personalCal.name, tasks: tasksCal.name, habits: habitsCal.name },
  };
}

/** The connected account's calendars, for first-time setup. */
async function listGoogleCalendars() {
  const token = await getValidAccessToken();
  const resp = await googleJson("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250", token);
  if (!resp.ok) throw googleFailure("Could not list calendars", resp.status, await resp.text());
  const data = await resp.json();
  const calendars = ((data.items ?? []) as { id: string; summary?: string; summaryOverride?: string; accessRole?: string; primary?: boolean; backgroundColor?: string }[])
    .filter((c) => c.id)
    .map((c) => ({ id: c.id, name: c.summaryOverride ?? c.summary ?? c.id, accessRole: c.accessRole ?? "reader", primary: !!c.primary, color: c.backgroundColor ?? null }));
  return { calendars };
}

/** A new calendar in the connected account (e.g. "My Planner" for the app's plan). */
async function createGoogleCalendar(name: string, timeZone: string) {
  const token = await getValidAccessToken();
  const resp = await googleJson("https://www.googleapis.com/calendar/v3/calendars", token, {
    method: "POST",
    body: JSON.stringify({ summary: name, timeZone }),
  });
  if (!resp.ok) throw new Error(`Could not create the calendar (${resp.status}): ${await resp.text()}`);
  const cal = await resp.json();
  return { calendar: { id: cal.id as string, name: (cal.summary as string) ?? name } };
}

async function exchangeCodeForTokens(code: string) {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const redirectUri = Deno.env.get("GOOGLE_REDIRECT_URI");

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth credentials not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI as edge function secrets.");
  }

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${errText}`);
  }

  const tokens = await resp.json();

  const userInfoResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const userInfo = userInfoResp.ok ? await userInfoResp.json() : {};

  await supabase.from("gcal_oauth_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("gcal_oauth_tokens").insert({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    access_token_expires_at: new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString(),
    email: userInfo.email ?? null,
  });

  return { email: userInfo.email ?? null };
}

async function getValidAccessToken(): Promise<string> {
  const { data: tokenRow, error } = await supabase
    .from("gcal_oauth_tokens")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !tokenRow) {
    throw new Error("Google account not connected. Use the OAuth flow first.");
  }

  const now = new Date();
  const expiresAt = tokenRow.access_token_expires_at ? new Date(tokenRow.access_token_expires_at) : null;

  if (tokenRow.access_token && expiresAt && expiresAt > now) {
    return tokenRow.access_token;
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth credentials not configured.");
  }

  const body = new URLSearchParams({
    refresh_token: tokenRow.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });

  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${errText}`);
  }

  const tokens = await resp.json();

  await supabase
    .from("gcal_oauth_tokens")
    .update({
      access_token: tokens.access_token,
      access_token_expires_at: new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", tokenRow.id);

  return tokens.access_token;
}

/** Runs async jobs with at most `limit` in flight. */
async function inBatches<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(fn));
  }
}

const sameTime = (a: string | null | undefined, b: string) => !!a && Date.parse(a) === Date.parse(b);

async function pullEvents(
  connections: { calendar_id: string; role: string; enabled: boolean }[],
  weekStart: string,
  rangeDays: number = 7
) {
  const accessToken = await getValidAccessToken();
  const weekStartDt = new Date(weekStart);
  const weekEndDt = new Date(weekStartDt.getTime() + rangeDays * 24 * 60 * 60 * 1000);

  const sourceConnections = connections.filter(
    (c) => (c.role === "fixed_source" || c.role === "display_only") && c.enabled && c.calendar_id
  );

  if (sourceConnections.length === 0) {
    return { eventsPulled: 0, message: "No enabled fixed-source calendars configured." };
  }

  let totalPulled = 0;
  // Events added to the app this run (for trip alerts).
  const newItems: { id: string; name: string; start: string; end: string; allDay: boolean }[] = [];
  // Every Google event id seen in each calendar this run, so events that were
  // deleted in Google or moved to another calendar can be removed afterwards.
  const seenIds = new Set<string>();
  const fullyListed = new Set<string>();

  // 1) Read every calendar from Google at the same time.
  const fetched = await Promise.all(
    sourceConnections.map(async (conn) => {
      // The app's own planned events (only on calendars it writes to). A calendar Google won't
      // search this way (e.g. one subscribed by link) simply has none.
      const ownPromise = listMirrorEvents(accessToken, conn.calendar_id).catch((e: Error) => {
        if (e.message === NO_CALENDAR_ACCESS) throw e;
        return [] as GoogleEvent[];
      });
      const url = new URL(GOOGLE_EVENTS_URL(conn.calendar_id));
      url.searchParams.set("timeMin", weekStartDt.toISOString());
      url.searchParams.set("timeMax", weekEndDt.toISOString());
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", "250");
      const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!resp.ok) {
        const errText = await resp.text();
        throw googleFailure(`Failed to read calendar ${conn.calendar_id}`, resp.status, errText);
      }
      const data = await resp.json();
      const own = await ownPromise;
      return { conn, data, ownIds: new Set(own.map((e) => e.id)) };
    })
  );

  // 2) What the app already has for those events, in a few batched reads.
  type MapRow = { id: string; item_id: string | null; calendar_role: string; calendar_id: string; google_event_id: string; item_name: string | null; start_time: string | null; end_time: string | null };
  type FeRow = { id: string; name: string; start_time: string; end_time: string; blocks_schedule: boolean | null; is_all_day: boolean | null; google_can_edit: boolean | null; source_done: boolean | null };
  const allIds = [...new Set(fetched.flatMap((f) => ((f.data.items ?? []) as GoogleEvent[]).map((e) => e.id)))];
  const mapByGoogleId = new Map<string, MapRow>();
  const chunks: string[][] = [];
  for (let i = 0; i < allIds.length; i += 100) chunks.push(allIds.slice(i, i + 100));
  await inBatches(chunks, 5, async (ids) => {
    const { data } = await supabase
      .from("gcal_event_map")
      .select("id, item_id, calendar_role, calendar_id, google_event_id, item_name, start_time, end_time")
      .in("google_event_id", ids);
    for (const r of (data as MapRow[]) ?? []) mapByGoogleId.set(r.google_event_id, r);
  });
  const feById = new Map<string, FeRow>();
  const itemIds = [...new Set([...mapByGoogleId.values()].map((r) => r.item_id).filter((x): x is string => !!x))];
  const itemChunks: string[][] = [];
  for (let i = 0; i < itemIds.length; i += 100) itemChunks.push(itemIds.slice(i, i + 100));
  await inBatches(itemChunks, 5, async (ids) => {
    const { data } = await supabase
      .from("fixed_events")
      .select("id, name, start_time, end_time, blocks_schedule, is_all_day, google_can_edit, source_done")
      .in("id", ids);
    for (const r of (data as FeRow[]) ?? []) feById.set(r.id, r);
  });

  // 3) Work out what changed; only those get written.
  const writes: (() => Promise<unknown>)[] = [];
  const inserts: (() => Promise<void>)[] = [];
  const calendarUpdates: (() => Promise<unknown>)[] = [];

  for (const { conn, data, ownIds } of fetched) {
    const events: GoogleEvent[] = data.items ?? [];
    const accessRole: string | undefined = data.accessRole;
    if (accessRole) {
      calendarUpdates.push(() => supabase.from("calendar_connections").update({ access_role: accessRole }).eq("calendar_id", conn.calendar_id));
    }
    for (const ev of events) seenIds.add(ev.id);
    if (!data.nextPageToken) fullyListed.add(conn.calendar_id);

    for (const ev of events) {
      if (
        ev.extendedProperties?.private?.ssMirror === "1" ||
        ownIds.has(ev.id) ||
        (ev.recurringEventId && ownIds.has(ev.recurringEventId))
      ) {
        continue;
      }
      const hasDateTime = ev.start?.dateTime && ev.end?.dateTime;
      const hasDate = ev.start?.date && ev.end?.date;

      if (!hasDateTime && !hasDate) continue;

      let evStart: Date;
      let evEnd: Date;
      let isAllDay = false;

      if (hasDateTime) {
        evStart = new Date(ev.start!.dateTime!);
        evEnd = new Date(ev.end!.dateTime!);
      } else {
        isAllDay = true;
        evStart = new Date(ev.start!.date!);
        evEnd = new Date(ev.end!.date!);
      }

      if (evStart < weekStartDt || evStart >= weekEndDt) continue;
      // A finished workout: Runna's completed-activity events carry a "📊 Summary" (and an activity link).
      // Only this flag is kept from the description; the text itself isn't stored.
      // Blocks your time only if its calendar blocks AND the event itself is Busy in Google.
      const blocksSchedule = conn.role !== "display_only" && ev.transparency !== "transparent";
      const sourceDone = /📊\s*Summary/.test(ev.description ?? "") || /runna\.com\/[^\s]*activities\?activityId=/.test(ev.description ?? "");
      const name = ev.summary ?? "Untitled event";
      const startIso = evStart.toISOString();
      const endIso = evEnd.toISOString();
      const canEdit = googleCanEdit(accessRole, ev);

      const existing = mapByGoogleId.get(ev.id);
      if (existing) {
        if (existing.calendar_role === "schedule_target") continue;
        const fe = existing.item_id ? feById.get(existing.item_id) : undefined;
        const feChanged =
          !fe ||
          fe.name !== name ||
          !sameTime(fe.start_time, startIso) ||
          !sameTime(fe.end_time, endIso) ||
          (fe.blocks_schedule ?? true) !== blocksSchedule ||
          !!fe.is_all_day !== isAllDay ||
          (fe.google_can_edit ?? true) !== canEdit ||
          !!fe.source_done !== sourceDone;
        if (feChanged && existing.item_id) {
          const itemId = existing.item_id;
          writes.push(() =>
            supabase
              .from("fixed_events")
              .update({ name, start_time: startIso, end_time: endIso, blocks_schedule: blocksSchedule, is_all_day: isAllDay, google_can_edit: canEdit, source_done: sourceDone })
              .eq("id", itemId)
          );
          if (fe) Object.assign(fe, { name, start_time: startIso, end_time: endIso, blocks_schedule: blocksSchedule, is_all_day: isAllDay, google_can_edit: canEdit, source_done: sourceDone });
        }
        const mapChanged =
          existing.item_name !== name ||
          !sameTime(existing.start_time, startIso) ||
          !sameTime(existing.end_time, endIso) ||
          existing.calendar_role !== conn.role ||
          existing.calendar_id !== conn.calendar_id;
        if (mapChanged) {
          const mapId = existing.id;
          writes.push(() =>
            supabase
              .from("gcal_event_map")
              .update({ item_name: name, start_time: startIso, end_time: endIso, calendar_role: conn.role, calendar_id: conn.calendar_id, synced_at: new Date().toISOString() })
              .eq("id", mapId)
          );
          Object.assign(existing, { item_name: name, start_time: startIso, end_time: endIso, calendar_role: conn.role, calendar_id: conn.calendar_id });
        }
      } else {
        // Claimed now so the same event in a second calendar isn't added twice.
        const placeholder: MapRow = { id: "", item_id: null, calendar_role: conn.role, calendar_id: conn.calendar_id, google_event_id: ev.id, item_name: name, start_time: startIso, end_time: endIso };
        mapByGoogleId.set(ev.id, placeholder);
        inserts.push(async () => {
          const guessedPillar = await resolvePillarForNewEvent(name);
          const { data: inserted, error: insertErr } = await supabase
            .from("fixed_events")
            .insert({
              name,
              start_time: startIso,
              end_time: endIso,
              blocks_schedule: blocksSchedule,
              is_all_day: isAllDay,
              pillar: guessedPillar,
              google_can_edit: canEdit,
              source_done: sourceDone,
            })
            .select("id")
            .maybeSingle();
          if (insertErr || !inserted) return;
          newItems.push({ id: inserted.id, name, start: startIso, end: endIso, allDay: isAllDay });
          await supabase.from("gcal_event_map").insert({
            google_event_id: ev.id,
            item_type: "fixed_event",
            item_id: inserted.id,
            item_name: name,
            calendar_role: conn.role,
            calendar_id: conn.calendar_id,
            start_time: startIso,
            end_time: endIso,
          });
        });
      }

      totalPulled++;
    }

    calendarUpdates.push(() =>
      supabase.from("calendar_connections").update({ last_synced_at: new Date().toISOString(), last_sync_error: null }).eq("calendar_id", conn.calendar_id)
    );
  }

  // 4) Write only what changed, several at a time.
  await inBatches(writes, 10, (w) => w());
  await inBatches(inserts, 5, (w) => w());
  await inBatches(calendarUpdates, 10, (w) => w());

  // Remove app copies of pulled events that are no longer in their Google
  // calendar within this window (deleted there, or moved to a calendar that
  // isn't connected). Only calendars listed completely this run are checked.
  let totalRemoved = 0;
  const checkedCalendars = [...new Set(sourceConnections.map((c) => c.calendar_id))].filter((id) => fullyListed.has(id));
  if (checkedCalendars.length > 0) {
    const { data: rows } = await supabase
      .from("gcal_event_map")
      .select("id, google_event_id, item_id, item_type, calendar_role")
      .in("calendar_id", checkedCalendars)
      .in("calendar_role", ["fixed_source", "display_only"])
      .eq("item_type", "fixed_event")
      // Runs copied in from Strava live alongside the run calendar's events, not in Google.
      .not("google_event_id", "like", "strava:%")
      // One-day margin at each edge: all-day events are stored at UTC midnight,
      // which can sit just outside the range Google was asked about.
      .gte("start_time", new Date(weekStartDt.getTime() + DAY_MS).toISOString())
      .lt("start_time", new Date(weekEndDt.getTime() - DAY_MS).toISOString());
    const gone = ((rows as { id: string; google_event_id: string; item_id: string | null }[]) ?? []).filter((r) => !seenIds.has(r.google_event_id));
    const goneItems = gone.map((r) => r.item_id).filter((x): x is string => !!x);
    for (let i = 0; i < goneItems.length; i += 100) await supabase.from("fixed_events").delete().in("id", goneItems.slice(i, i + 100));
    const goneMaps = gone.map((r) => r.id);
    for (let i = 0; i < goneMaps.length; i += 100) await supabase.from("gcal_event_map").delete().in("id", goneMaps.slice(i, i + 100));
    totalRemoved = gone.length;
  }

  return { eventsPulled: totalPulled, eventsRemoved: totalRemoved, newItems };
}

// ---- Background pull (pg_cron, every 15 min) ---------------------------------
// Keeps the app's copy of Google fresh while the app is closed, and sends a
// trip alert when new flights appear in the next few days (e.g. a reserve
// assignment posted by Crew Scheduling).

const easternParts = () => new Intl.DateTimeFormat("en-US", {
  timeZone: HOME_TIME_ZONE,
  hourCycle: "h23",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
function eastern(iso: string) {
  const p = Object.fromEntries(easternParts().formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { day: `${p.weekday}, ${p.month} ${p.day}`, time: `${p.hour}:${p.minute}` };
}

async function backgroundPull() {
  const { data: token } = await supabase.from("gcal_oauth_tokens").select("id").limit(1).maybeSingle();
  if (!token) return { skipped: "Google not connected" };
  const { data: conns } = await supabase.from("calendar_connections").select("calendar_id, role, enabled, name");
  const connections = ((conns as { calendar_id: string; role: string; enabled: boolean; name: string }[]) ?? []).filter((c) => c.enabled);
  const from = new Date(Date.now() - DAY_MS);
  const result = await pullEvents(connections, from.toISOString(), 21);
  if (result.newItems?.length || (result as { eventsRemoved?: number }).eventsRemoved) {
    await supabase.from("gcal_sync_runs").insert({ direction: "pull", status: "success", events_pulled: result.newItems?.length ?? 0 });
  }

  // Trip alerts
  const { data: settings } = await supabase.from("reminder_settings").select("enabled, trips").eq("id", 1).maybeSingle();
  if (!settings?.enabled || settings.trips === false) return { ...result, alerts: 0 };
  const now = Date.now();
  const soon = now + 4 * DAY_MS;
  const flights = (result.newItems ?? [])
    .filter((i) => !i.allDay && FLIGHT_LEG_PATTERN.test(i.name))
    .filter((i) => Date.parse(i.start) > now && Date.parse(i.start) < soon)
    .sort((a, b) => a.start.localeCompare(b.start));
  const byDay = new Map<string, typeof flights>();
  for (const f of flights) {
    const d = eastern(f.start).day;
    byDay.set(d, [...(byDay.get(d) ?? []), f]);
  }
  let alerts = 0;
  for (const [day, legs] of byDay) {
    const list = legs
      .map((l) => {
        const m = FLIGHT_LEG_PATTERN.exec(l.name);
        return `${m ? `${m[1]}→${m[2]}` : l.name} ${eastern(l.start).time}`;
      })
      .join(", ");
    const { error } = await supabase.from("reminders").insert({
      key: `trip:${legs[0].id}`,
      send_at: new Date().toISOString(),
      title: "New trip on your calendar",
      body: `${day}: ${list}. Open the app to check it and confirm your assignment.`,
      url: "/?view=briefing",
      kind: "trip",
    });
    if (!error) alerts++;
  }
  return { ...result, alerts };
}

async function pushEvents(
  connections: { calendar_id: string; role: string; enabled: boolean; name: string }[],
  placedItems: PlacedItemForPush[]
) {
  const accessToken = await getValidAccessToken();

  const targetConnections = connections.filter(
    (c) => c.role === "schedule_target" && c.enabled && c.calendar_id
  );

  if (targetConnections.length === 0) {
    return { eventsPushed: 0, message: "No enabled schedule-target calendars configured." };
  }

  const habitCalendar = targetConnections.find((c) => /habit/i.test(c.name)) ?? targetConnections[0];
  const taskCalendar = targetConnections.find((c) => /task/i.test(c.name)) ?? targetConnections[0];

  let totalPushed = 0;

  for (const item of placedItems) {
    const targetCalendar = item.kind === "Habit" ? habitCalendar : taskCalendar;

    if (!targetCalendar) continue;

    const occWeekStart = new Date(item.occurrenceWeek);
    const occWeekEnd = new Date(occWeekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

    const colorId = item.kind === "Habit" ? "10" : "9";

    const body = {
      summary: item.name,
      description: item.isBatch && item.memberNames
        ? `Batched tasks: ${item.memberNames.join(", ")}`
        : `${item.kind} — Tier ${item.tier}, Context: ${item.context}`,
      start: { dateTime: item.start },
      end: { dateTime: item.end },
      colorId,
    };

    const { data: existing } = await supabase
      .from("gcal_event_map")
      .select("id, google_event_id")
      .eq("item_type", item.kind === "Habit" ? "habit" : "task")
      .eq("item_id", item.id)
      .eq("calendar_role", "schedule_target")
      .gte("start_time", occWeekStart.toISOString())
      .lt("start_time", occWeekEnd.toISOString())
      .maybeSingle();

    if (existing) {
      const updateUrl = `${GOOGLE_EVENTS_URL(targetCalendar.calendar_id)}/${existing.google_event_id}`;
      const resp = await fetch(updateUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (resp.ok) {
        totalPushed++;
        await supabase
          .from("gcal_event_map")
          .update({ start_time: item.start, end_time: item.end, synced_at: new Date().toISOString() })
          .eq("id", existing.id);
      }
    } else {
      const resp = await fetch(GOOGLE_EVENTS_URL(targetCalendar.calendar_id), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (resp.ok) {
        const created = await resp.json();
        await supabase.from("gcal_event_map").insert({
          google_event_id: created.id,
          item_type: item.kind === "Habit" ? "habit" : "task",
          item_id: item.id,
          item_name: item.name,
          calendar_role: "schedule_target",
          calendar_id: targetCalendar.calendar_id,
          start_time: item.start,
          end_time: item.end,
        });
        totalPushed++;
      }
    }
  }

  for (const conn of targetConnections) {
    await supabase
      .from("calendar_connections")
      .update({ last_synced_at: new Date().toISOString(), last_sync_error: null })
      .eq("calendar_id", conn.calendar_id);
  }

  return { eventsPushed: totalPushed };
}

/**
 * Move/resize an event that was pulled from one of the user's Google calendars,
 * so a change made by dragging in the app is saved at the source (e.g. Runna,
 * which syncs Google Calendar changes back into its own app).
 */
async function updateSourceEvent(googleEventId: string, calendarId: string, start: string, end: string, allDay = false, busy?: boolean) {
  const accessToken = await getValidAccessToken();
  const url = `${GOOGLE_EVENTS_URL(calendarId)}/${encodeURIComponent(googleEventId)}`;
  const auth = { Authorization: `Bearer ${accessToken}` };
  const cur = await fetch(url, { headers: auth });
  if (!cur.ok) throw new Error(`Couldn't find this event in Google Calendar (${cur.status}).`);
  const ev = await cur.json();
  // Switching between all-day and timed: clear the other field (a PATCH merges).
  const tz = ev.start?.timeZone ?? ev.end?.timeZone ?? (ev.start?.date ? HOME_TIME_ZONE : undefined);
  const body: Record<string, unknown> = allDay
    ? { start: { date: start, dateTime: null, timeZone: null }, end: { date: end, dateTime: null, timeZone: null } }
    : {
        start: { dateTime: start, date: null, ...(tz ? { timeZone: tz } : {}) },
        end: { dateTime: end, date: null, ...(tz ? { timeZone: tz } : {}) },
      };
  // Busy / Free in Google (e.g. an all-day workout given a time that should now block it).
  if (busy !== undefined) body.transparency = busy ? "opaque" : "transparent";
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 403) throw new Error("Google won't let the app change events on this calendar (it's read-only for your account).");
    throw new Error(`Google rejected the change (${resp.status}): ${text.slice(0, 200)}`);
  }
  await supabase
    .from("gcal_event_map")
    .update({
      start_time: allDay ? `${start}T00:00:00.000Z` : start,
      end_time: allDay ? `${end}T00:00:00.000Z` : end,
      synced_at: new Date().toISOString(),
    })
    .eq("google_event_id", googleEventId)
    .eq("calendar_id", calendarId);
  return { updated: true };
}

async function getSyncStatus() {
  const { data: tokenRow } = await supabase
    .from("gcal_oauth_tokens")
    .select("email, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: recentRuns } = await supabase
    .from("gcal_sync_runs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(5);

  const { data: connections } = await supabase
    .from("calendar_connections")
    .select("*")
    .order("created_at");

  return {
    functionVersion: "2026-10-19-fast-pull",
    connected: !!tokenRow,
    email: tokenRow?.email ?? null,
    recentRuns: recentRuns ?? [],
    connections: connections ?? [],
  };
}

async function disconnect() {
  await supabase.from("gcal_oauth_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabase.from("gcal_event_map").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  return { disconnected: true };
}

async function deleteEvent(itemType: string, itemId: string) {
  const { data: mapping, error: mapErr } = await supabase
    .from("gcal_event_map")
    .select("google_event_id, calendar_id, calendar_role")
    .eq("item_type", itemType)
    .eq("item_id", itemId)
    .maybeSingle();

  if (mapErr) throw new Error(`Failed to look up Google event mapping: ${mapErr.message}`);

  if (!mapping) {
    return { deleted: false, message: "No linked Google event found for this item." };
  }

  if (mapping.google_event_id.startsWith(STRAVA_PREFIX)) {
    return { deleted: false, error: "This run comes from Strava. Delete or change it in Strava and it updates here." };
  }

  // Display-only calendars don't hold time, but deleting follows Google's own
  // permissions: a calendar you own or can edit (e.g. Informational) deletes in
  // Google too; one you can only view (e.g. Jatara's) can't be deleted at all.
  if (mapping.calendar_role === "display_only") {
    const { data: conn } = await supabase
      .from("calendar_connections")
      .select("access_role")
      .eq("calendar_id", mapping.calendar_id)
      .limit(1)
      .maybeSingle();
    const role = conn?.access_role ?? "owner";
    if (role !== "owner" && role !== "writer") {
      return { deleted: false, error: "You can only view this calendar in Google, so its events can't be deleted." };
    }
  }

  const accessToken = await getValidAccessToken();
  const deleteUrl = `${GOOGLE_EVENTS_URL(mapping.calendar_id)}/${mapping.google_event_id}`;
  const resp = await fetch(deleteUrl, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Gone already (404/410) counts as deleted. On any other failure keep the link,
  // so the next sync doesn't pull the event back in as a duplicate.
  if (!resp.ok && resp.status !== 410 && resp.status !== 404) {
    const errText = await resp.text();
    return { deleted: false, error: `Google delete failed (${resp.status}): ${errText}` };
  }

  await supabase.from("gcal_event_map").delete().eq("item_type", itemType).eq("item_id", itemId);
  return { deleted: true };
}

// ---- Strava: completed runs ---------------------------------------------------
// Runna doesn't always replace a planned workout with the finished run on its
// Google calendar. Strava has every run, so each run is copied in as a finished
// event on the Run goal's calendar (once, keyed by its Strava activity id). When
// Runna's own completed event for the same run is there, that one is used instead.

const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_API = "https://www.strava.com/api/v3";
const STRAVA_PREFIX = "strava:";
/** A Strava run and a Runna completed event this close together are the same run. */
const SAME_RUN_MS = 20 * 60 * 1000;

interface StravaActivity {
  id: number;
  name: string;
  sport_type?: string;
  type?: string;
  start_date: string;
  elapsed_time: number;
  moving_time: number;
  distance: number;
}

async function stravaPost(params: Record<string, string>) {
  const clientId = Deno.env.get("STRAVA_CLIENT_ID");
  const clientSecret = Deno.env.get("STRAVA_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Strava isn't set up: add STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET as secrets.");
  const resp = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  if (!resp.ok) throw new Error(`Strava sign-in failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
  return await resp.json();
}

async function saveStravaTokens(t: { access_token: string; refresh_token: string; expires_at: number; athlete?: { id?: number; firstname?: string; lastname?: string } }, keepAthlete = false) {
  const row: Record<string, unknown> = {
    id: 1,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: new Date(t.expires_at * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (!keepAthlete && t.athlete) {
    row.athlete_id = t.athlete.id ?? null;
    row.athlete_name = [t.athlete.firstname, t.athlete.lastname].filter(Boolean).join(" ") || null;
  }
  const { error } = await supabase.from("strava_tokens").upsert(row);
  if (error) throw new Error(`Couldn't save the Strava connection: ${error.message}`);
}

async function stravaAccessToken(): Promise<string> {
  const { data: row } = await supabase.from("strava_tokens").select("access_token, refresh_token, expires_at").eq("id", 1).maybeSingle();
  if (!row) throw new Error("Strava isn't connected.");
  if (new Date(row.expires_at).getTime() - Date.now() > 5 * 60 * 1000) return row.access_token;
  const t = await stravaPost({ grant_type: "refresh_token", refresh_token: row.refresh_token });
  await saveStravaTokens(t, true);
  return t.access_token;
}

/** The calendar your Run goal counts from (where finished runs belong). */
async function runCalendarId(): Promise<string | null> {
  const { data: goals } = await supabase.from("goals").select("count_calendar_id").eq("plan_mode", "count").not("count_calendar_id", "is", null);
  const ids = [...new Set(((goals as { count_calendar_id: string }[]) ?? []).map((g) => g.count_calendar_id))];
  const { data: conns } = await supabase.from("calendar_connections").select("calendar_id, name");
  const named = ((conns as { calendar_id: string; name: string }[]) ?? []).filter((c) => /runna|run/i.test(c.name)).map((c) => c.calendar_id);
  return ids.find((id) => named.includes(id)) ?? ids[0] ?? named[0] ?? null;
}

async function stravaSync(days = 30) {
  const token = await stravaAccessToken();
  const runCal = await runCalendarId();
  if (!runCal) {
    await supabase.from("strava_tokens").update({ last_sync_error: "No Run goal calendar to put runs on." }).eq("id", 1);
    throw new Error("Set up a Run goal that counts from your running calendar first.");
  }
  const after = new Date(Date.now() - days * DAY_MS);
  const acts: StravaActivity[] = [];
  for (let page = 1; page <= 5; page++) {
    const url = `${STRAVA_API}/athlete/activities?after=${Math.floor(after.getTime() / 1000)}&per_page=100&page=${page}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      const msg = `Strava activities (${resp.status}): ${(await resp.text()).slice(0, 200)}`;
      await supabase.from("strava_tokens").update({ last_sync_error: msg }).eq("id", 1);
      throw new Error(msg);
    }
    const batch = (await resp.json()) as StravaActivity[];
    acts.push(...batch);
    if (batch.length < 100) break;
  }
  const runs = acts.filter((a) => /run/i.test(a.sport_type ?? a.type ?? ""));

  // What's already there: our Strava copies, and Runna's own finished runs.
  const since = new Date(after.getTime() - DAY_MS).toISOString();
  const { data: mapRows } = await supabase
    .from("gcal_event_map")
    .select("id, item_id, google_event_id, start_time")
    .eq("calendar_id", runCal)
    .eq("item_type", "fixed_event")
    .gte("start_time", since);
  const rows = (mapRows as { id: string; item_id: string | null; google_event_id: string; start_time: string }[]) ?? [];
  const ours = new Map(rows.filter((r) => r.google_event_id.startsWith(STRAVA_PREFIX)).map((r) => [r.google_event_id, r]));
  const runnaIds = rows.filter((r) => !r.google_event_id.startsWith(STRAVA_PREFIX) && r.item_id).map((r) => r.item_id!);
  const runnaDone: number[] = [];
  for (let i = 0; i < runnaIds.length; i += 100) {
    const { data } = await supabase.from("fixed_events").select("start_time").in("id", runnaIds.slice(i, i + 100)).eq("source_done", true).eq("is_all_day", false);
    for (const e of (data as { start_time: string }[]) ?? []) runnaDone.push(Date.parse(e.start_time));
  }

  let added = 0;
  let updated = 0;
  let matched = 0;
  let removed = 0;
  const seen = new Set<string>();
  for (const a of runs) {
    const key = STRAVA_PREFIX + a.id;
    seen.add(key);
    const start = new Date(a.start_date);
    const end = new Date(start.getTime() + Math.max(60, a.elapsed_time || a.moving_time || 0) * 1000);
    const mine = ours.get(key);
    // Runna posted this run itself: use its event, drop our copy.
    if (runnaDone.some((t) => Math.abs(t - start.getTime()) <= SAME_RUN_MS)) {
      if (mine) {
        if (mine.item_id) await supabase.from("fixed_events").delete().eq("id", mine.item_id);
        await supabase.from("gcal_event_map").delete().eq("id", mine.id);
      }
      matched++;
      continue;
    }
    const miles = a.distance ? (a.distance / 1609.344).toFixed(2) : null;
    const name = `🏃 ${a.name || "Run"}${miles ? ` · ${miles} mi` : ""}`;
    if (mine?.item_id) {
      await supabase.from("fixed_events").update({ name, start_time: start.toISOString(), end_time: end.toISOString() }).eq("id", mine.item_id);
      await supabase.from("gcal_event_map").update({ item_name: name, start_time: start.toISOString(), end_time: end.toISOString(), synced_at: new Date().toISOString() }).eq("id", mine.id);
      updated++;
      continue;
    }
    const { data: ins, error } = await supabase
      .from("fixed_events")
      .insert({
        name,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        blocks_schedule: true,
        is_all_day: false,
        pillar: "physical",
        google_can_edit: false,
        source_done: true,
      })
      .select("id")
      .maybeSingle();
    if (error || !ins) continue;
    await supabase.from("gcal_event_map").insert({
      google_event_id: key,
      item_type: "fixed_event",
      item_id: ins.id,
      item_name: name,
      calendar_role: "fixed_source",
      calendar_id: runCal,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    });
    added++;
  }
  // Runs deleted in Strava (or no longer runs) within the window.
  for (const [key, r] of ours) {
    if (seen.has(key) || Date.parse(r.start_time) < after.getTime()) continue;
    if (r.item_id) await supabase.from("fixed_events").delete().eq("id", r.item_id);
    await supabase.from("gcal_event_map").delete().eq("id", r.id);
    removed++;
  }
  await supabase.from("strava_tokens").update({ last_sync_at: new Date().toISOString(), last_sync_error: null }).eq("id", 1);
  return { runs: runs.length, added, updated, matched, removed };
}

async function stravaStatus() {
  const clientReady = !!Deno.env.get("STRAVA_CLIENT_ID") && !!Deno.env.get("STRAVA_CLIENT_SECRET");
  const { data: row } = await supabase.from("strava_tokens").select("athlete_name, last_sync_at, last_sync_error").eq("id", 1).maybeSingle();
  const { count } = await supabase.from("gcal_event_map").select("id", { count: "exact", head: true }).like("google_event_id", `${STRAVA_PREFIX}%`);
  // The client ID is public (it's in the sign-in link), so the app reads it from here instead of its own settings.
  return { clientReady, clientId: Deno.env.get("STRAVA_CLIENT_ID") ?? null, connected: !!row, athlete: row?.athlete_name ?? null, lastSyncAt: row?.last_sync_at ?? null, lastError: row?.last_sync_error ?? null, runsOnCalendar: count ?? 0 };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body: SyncRequest = await req.json();
    let result: Record<string, unknown>;
    await loadHomeTimeZone().catch(() => undefined);

    switch (body.action) {
      case "oauth-exchange": {
        if (!body.code) throw new Error("Authorization code is required.");
        const { email } = await exchangeCodeForTokens(body.code);
        await supabase.from("gcal_sync_runs").insert({
          direction: "pull",
          status: "success",
          events_pulled: 0,
          error_message: `OAuth connected for ${email ?? "unknown"}`,
        });
        result = { success: true, email };
        break;
      }

      case "pull": {
        if (!body.weekStart) throw new Error("weekStart is required.");
        if (!body.connections) throw new Error("connections is required.");
        const conns = body.connections.map((c) => ({
          calendar_id: c.calendar_id,
          role: c.role,
          enabled: c.enabled,
          name: c.name,
        }));
        const pullResult = await pullEvents(conns, body.weekStart, body.rangeDays ?? 30);
        await supabase.from("gcal_sync_runs").insert({
          direction: "pull",
          status: "success",
          events_pulled: pullResult.eventsPulled,
        });
        result = { success: true, ...pullResult };
        break;
      }

      case "push": {
        if (!body.placedItems) throw new Error("placedItems is required.");
        if (!body.connections) throw new Error("connections is required.");
        const conns = body.connections.map((c) => ({
          calendar_id: c.calendar_id,
          role: c.role,
          enabled: c.enabled,
          name: c.name,
        }));
        const pushResult = await pushEvents(conns, body.placedItems);
        await supabase.from("gcal_sync_runs").insert({
          direction: "push",
          status: "success",
          events_pushed: pushResult.eventsPushed,
        });
        result = { success: true, ...pushResult };
        break;
      }

      case "mirror": {
        if (!body.items) throw new Error("items is required.");
        if (!body.windowStart) throw new Error("windowStart is required.");
        if (!body.connections) throw new Error("connections is required.");
        const mirrorResult = await mirrorEvents(body.connections, body.items, body.windowStart);
        await supabase.from("gcal_sync_runs").insert({
          direction: "push",
          status: mirrorResult.errors && mirrorResult.errors.length ? "partial" : "success",
          events_pushed: mirrorResult.eventsPushed ?? 0,
          error_message: mirrorResult.errors && mirrorResult.errors.length ? mirrorResult.errors.slice(0, 3).join(" | ") : null,
        });
        result = { success: true, ...mirrorResult };
        break;
      }

      case "status": {
        result = await getSyncStatus();
        break;
      }

      case "list-calendars": {
        result = await listGoogleCalendars();
        break;
      }

      case "create-calendar": {
        if (!body.calendarName) throw new Error("A calendar name is required.");
        result = await createGoogleCalendar(body.calendarName, body.timeZone ?? HOME_TIME_ZONE);
        break;
      }

      case "disconnect": {
        result = await disconnect();
        break;
      }

      case "delete": {
        if (!body.itemType) throw new Error("itemType is required.");
        if (!body.itemId) throw new Error("itemId is required.");
        const delResult = await deleteEvent(body.itemType, body.itemId);
        result = { success: true, ...delResult };
        break;
      }

      case "strava-exchange": {
        if (!body.code) throw new Error("Authorization code is required.");
        const t = await stravaPost({ grant_type: "authorization_code", code: body.code });
        await saveStravaTokens(t);
        result = { success: true, athlete: t.athlete?.firstname ?? null, ...(await stravaSync(30).catch((e) => ({ syncError: String(e) }))) };
        break;
      }

      case "strava-status": {
        result = { success: true, ...(await stravaStatus()) };
        break;
      }

      case "strava-sync": {
        result = { success: true, ...(await stravaSync(body.rangeDays ?? 30)) };
        break;
      }

      case "strava-disconnect": {
        await supabase.from("strava_tokens").delete().eq("id", 1);
        result = { success: true };
        break;
      }

      case "background-pull": {
        const pulled = await backgroundPull();
        // Then finished runs from Strava (after the pull, so Runna's own completed events are seen first).
        const strava = await stravaSync(14).catch((e) => ({ skipped: String(e instanceof Error ? e.message : e) }));
        result = { success: true, ...pulled, strava };
        break;
      }

      case "update-source-event": {
        if (!body.googleEventId || !body.calendarId || !body.start || !body.end) {
          throw new Error("googleEventId, calendarId, start and end are required.");
        }
        result = { success: true, ...(await updateSourceEvent(body.googleEventId, body.calendarId, body.start, body.end, !!body.allDay, typeof body.busy === "boolean" ? body.busy : undefined)) };
        break;
      }

      default:
        throw new Error(`Unknown action: ${body.action}`);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await supabase.from("gcal_sync_runs").insert({
      direction: "pull",
      status: "error",
      error_message: message,
    });
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});






