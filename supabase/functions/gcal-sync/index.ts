import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const HOME_TIME_ZONE = "America/New_York";
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

const FLIGHT_LEG_PATTERN = /[A-Z]{3}\s*(?:â|->)\s*[A-Z]{3}/;

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
  action: "oauth-exchange" | "pull" | "push" | "mirror" | "status" | "disconnect" | "delete" | "update-source-event";
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
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  recurringEventId?: string;
  originalStartTime?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
  organizer?: { email?: string; self?: boolean };
  guestsCanModify?: boolean;
  locked?: boolean;
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
      throw new Error(`Failed to list Smart Scheduler events on ${calendarId} (${resp.status}): ${await resp.text()}`);
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
  const personalCal =
    enabled.find((c) => c.role !== "schedule_target" && /personal|family/i.test(c.name)) ?? tasksCal;
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
  // Every Google event id seen in each calendar this run, so events that were
  // deleted in Google or moved to another calendar can be removed afterwards.
  const seenIds = new Set<string>();
  const fullyListed = new Set<string>();

  for (const conn of sourceConnections) {
    const ownIds = new Set((await listMirrorEvents(accessToken, conn.calendar_id)).map((e) => e.id));
    const url = new URL(GOOGLE_EVENTS_URL(conn.calendar_id));
    url.searchParams.set("timeMin", weekStartDt.toISOString());
    url.searchParams.set("timeMax", weekEndDt.toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Failed to read calendar ${conn.calendar_id} (${resp.status}): ${errText}`);
    }

    const data = await resp.json();
    const events: GoogleEvent[] = data.items ?? [];
    const accessRole: string | undefined = data.accessRole;
    if (accessRole) {
      await supabase.from("calendar_connections").update({ access_role: accessRole }).eq("calendar_id", conn.calendar_id);
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

      const { data: existing } = await supabase
        .from("gcal_event_map")
        .select("id, item_id, calendar_role")
        .eq("google_event_id", ev.id)
        .maybeSingle();

      if (existing) {
        if (existing.calendar_role === "schedule_target") {
          continue;
        }
        await supabase
          .from("fixed_events")
          .update({
            name: ev.summary ?? "Untitled event",
            start_time: evStart.toISOString(),
            end_time: evEnd.toISOString(),
            blocks_schedule: conn.role !== "display_only",
            is_all_day: isAllDay,
            google_can_edit: googleCanEdit(accessRole, ev),
          })
          .eq("id", existing.item_id);

        await supabase
          .from("gcal_event_map")
          .update({
            item_name: ev.summary ?? "Untitled event",
            start_time: evStart.toISOString(),
            end_time: evEnd.toISOString(),
            calendar_role: conn.role,
            calendar_id: conn.calendar_id,
            synced_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        const guessedPillar = await resolvePillarForNewEvent(ev.summary ?? "Untitled event");
          const { data: inserted, error: insertErr } = await supabase
            .from("fixed_events")
            .insert({
              name: ev.summary ?? "Untitled event",
              start_time: evStart.toISOString(),
              end_time: evEnd.toISOString(),
              blocks_schedule: conn.role !== "display_only",
              is_all_day: isAllDay,
              pillar: guessedPillar,
              google_can_edit: googleCanEdit(accessRole, ev),
            })
          .select("id")
          .maybeSingle();

        if (insertErr || !inserted) continue;

        await supabase.from("gcal_event_map").insert({
          google_event_id: ev.id,
          item_type: "fixed_event",
          item_id: inserted.id,
          item_name: ev.summary ?? "Untitled event",
          calendar_role: conn.role,
          calendar_id: conn.calendar_id,
          start_time: evStart.toISOString(),
          end_time: evEnd.toISOString(),
        });
      }

      totalPulled++;
    }

    await supabase
      .from("calendar_connections")
      .update({ last_synced_at: new Date().toISOString(), last_sync_error: null })
      .eq("calendar_id", conn.calendar_id);
  }

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
      // One-day margin at each edge: all-day events are stored at UTC midnight,
      // which can sit just outside the range Google was asked about.
      .gte("start_time", new Date(weekStartDt.getTime() + DAY_MS).toISOString())
      .lt("start_time", new Date(weekEndDt.getTime() - DAY_MS).toISOString());
    for (const row of rows ?? []) {
      if (seenIds.has(row.google_event_id)) continue;
      if (row.item_id) await supabase.from("fixed_events").delete().eq("id", row.item_id);
      await supabase.from("gcal_event_map").delete().eq("id", row.id);
      totalRemoved++;
    }
  }

  return { eventsPulled: totalPulled, eventsRemoved: totalRemoved };
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
async function updateSourceEvent(googleEventId: string, calendarId: string, start: string, end: string, allDay = false) {
  const accessToken = await getValidAccessToken();
  const url = `${GOOGLE_EVENTS_URL(calendarId)}/${encodeURIComponent(googleEventId)}`;
  const auth = { Authorization: `Bearer ${accessToken}` };
  const cur = await fetch(url, { headers: auth });
  if (!cur.ok) throw new Error(`Couldn't find this event in Google Calendar (${cur.status}).`);
  const ev = await cur.json();
  // Switching between all-day and timed: clear the other field (a PATCH merges).
  const tz = ev.start?.timeZone ?? ev.end?.timeZone ?? (ev.start?.date ? HOME_TIME_ZONE : undefined);
  const body = allDay
    ? { start: { date: start, dateTime: null, timeZone: null }, end: { date: end, dateTime: null, timeZone: null } }
    : {
        start: { dateTime: start, date: null, ...(tz ? { timeZone: tz } : {}) },
        end: { dateTime: end, date: null, ...(tz ? { timeZone: tz } : {}) },
      };
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body: SyncRequest = await req.json();
    let result: Record<string, unknown>;

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

      case "update-source-event": {
        if (!body.googleEventId || !body.calendarId || !body.start || !body.end) {
          throw new Error("googleEventId, calendarId, start and end are required.");
        }
        result = { success: true, ...(await updateSourceEvent(body.googleEventId, body.calendarId, body.start, body.end, !!body.allDay)) };
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



