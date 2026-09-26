/**
 * Web Push for the home-screen app.
 *
 * Actions:
 *   config       → { publicKey }  (creates the VAPID key pair the first time)
 *   subscribe    { subscription, userAgent } → saves this device
 *   unsubscribe  { endpoint }
 *   status       { endpoint? } → { devices, thisDevice }
 *   test         → sends a test notification to every device now
 *   send-due     → (pg_cron, every minute) sends reminders whose time has come
 *
 * Deploy with JWT verification off: the cron job calls it without a token, and
 * nothing here returns private data (the private key never leaves the database).
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// VAPID "subject": who runs this app (a URL is allowed instead of an email).
const SUBJECT = "https://web-app-development-acoa.bolt.host";
// Reminders more than this late are dropped instead of sent.
const STALE_MS = 3 * 3600 * 1000;

interface Keys {
  publicKey: string;
  privateKey: string;
}

interface SubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

interface Payload {
  title: string;
  body: string;
  url?: string | null;
  tag?: string;
}

let keysCache: Keys | null = null;

async function vapidKeys(): Promise<Keys> {
  if (keysCache) return keysCache;
  const { data } = await supabase.from("push_config").select("public_key, private_key").eq("id", 1).maybeSingle();
  if (data) {
    keysCache = { publicKey: data.public_key, privateKey: data.private_key };
    return keysCache;
  }
  const k = webpush.generateVAPIDKeys();
  // If two requests race, the first insert wins and we read it back.
  await supabase.from("push_config").upsert({ id: 1, public_key: k.publicKey, private_key: k.privateKey }, { onConflict: "id", ignoreDuplicates: true });
  const { data: saved, error } = await supabase.from("push_config").select("public_key, private_key").eq("id", 1).single();
  if (error || !saved) throw new Error(`Couldn't store the push keys: ${error?.message ?? "unknown"}`);
  keysCache = { publicKey: saved.public_key, privateKey: saved.private_key };
  return keysCache;
}

/** Send one notification to one device. "gone" means the device unsubscribed. */
async function sendOne(sub: SubRow, payload: Payload, keys: Keys): Promise<"ok" | "gone" | string> {
  const det = webpush.generateRequestDetails(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify(payload),
    { vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 4 * 3600, urgency: "high" },
  );
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(det.headers as Record<string, unknown>)) {
    if (k.toLowerCase() === "content-length") continue;
    headers[k] = String(v);
  }
  const res = await fetch(det.endpoint, { method: det.method, headers, body: new Uint8Array(det.body as ArrayLike<number>) });
  if (res.status === 404 || res.status === 410) return "gone";
  if (!res.ok) return `${res.status} ${(await res.text()).slice(0, 200)}`;
  return "ok";
}

async function sendToAll(payload: Payload) {
  const keys = await vapidKeys();
  const { data: subs } = await supabase.from("push_subscriptions").select("id, endpoint, p256dh, auth");
  const results: { device: string; result: string }[] = [];
  for (const sub of (subs as SubRow[]) ?? []) {
    let result: string;
    try {
      result = await sendOne(sub, payload, keys);
    } catch (e) {
      result = e instanceof Error ? e.message : String(e);
    }
    results.push({ device: new URL(sub.endpoint).host, result });
    if (result === "gone") await supabase.from("push_subscriptions").delete().eq("id", sub.id);
    else if (result === "ok") await supabase.from("push_subscriptions").update({ last_success_at: new Date().toISOString(), last_error: null }).eq("id", sub.id);
    else await supabase.from("push_subscriptions").update({ last_error: result }).eq("id", sub.id);
  }
  return results;
}

// ---- Reminders the server schedules itself (no app needed) ------------------
// Weekly Review (Sun 21:30), monthly briefing (last day of the month, 20:00),
// and a plain morning briefing nudge when the app didn't plan one (it plans the
// detailed one each time it's opened).

const HOME_TZ = "America/New_York";
const homeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: HOME_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function homeNow(d = new Date()) {
  const p = Object.fromEntries(homeFmt.formatToParts(d).map((x) => [x.type, x.value]));
  const y = +p.year, mo = +p.month, day = +p.day;
  return { y, mo, day, mins: (+p.hour % 24) * 60 + +p.minute, weekday: p.weekday, date: `${p.year}-${p.month}-${p.day}` };
}

const toMins = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

async function scheduleServerReminders() {
  const { data: s } = await supabase.from("reminder_settings").select("*").eq("id", 1).maybeSingle();
  if (!s?.enabled) return;
  const h = homeNow();
  // A 15-minute window, so a late or skipped cron minute still catches it; keys stop repeats.
  const within = (hm: string) => h.mins >= toMins(hm) && h.mins < toMins(hm) + 15;
  const lastDay = new Date(Date.UTC(h.y, h.mo, 0)).getUTCDate() === h.day;
  const rows: Record<string, unknown>[] = [];
  if (s.weekly !== false && h.weekday === "Sun" && within("21:30")) {
    rows.push({ key: `weekly:${h.date}`, title: "Weekly Review", body: "Sunday 21:30 — look back at this week and approve next week's plan.", url: "/?view=review", kind: "weekly" });
  }
  if (s.monthly !== false && lastDay && within("20:00")) {
    rows.push({
      key: `monthly:${h.date}`,
      title: "Monthly briefing",
      body: `Last day of ${MONTHS[h.mo - 1]} — look back at the month and ahead to ${MONTHS[h.mo % 12]}.`,
      url: "/?view=briefing",
      kind: "monthly",
    });
  }
  if (s.morning !== false && typeof s.morning_time === "string" && within(s.morning_time)) {
    const { data: planned } = await supabase.from("reminders").select("id").eq("key", `morning:${h.date}`).maybeSingle();
    if (!planned) {
      const label = new Date(Date.UTC(h.y, h.mo - 1, h.day, 12)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
      rows.push({ key: `morning:${h.date}`, title: `Briefing · ${label}`, body: "Open Smart Scheduler for today's briefing.", url: "/?view=briefing", kind: "morning" });
    }
  }
  if (!rows.length) return;
  const now = new Date().toISOString();
  await supabase.from("reminders").upsert(rows.map((r) => ({ ...r, send_at: now })), { onConflict: "key", ignoreDuplicates: true });
}

async function sendDue() {
  try {
    await scheduleServerReminders();
  } catch (e) {
    console.error("server reminders:", e);
  }
  const now = new Date();
  // Too late to be useful: mark and skip.
  await supabase
    .from("reminders")
    .update({ sent_at: now.toISOString(), status: "expired" })
    .is("sent_at", null)
    .lt("send_at", new Date(now.getTime() - STALE_MS).toISOString());

  const { data: due } = await supabase
    .from("reminders")
    .select("id")
    .is("sent_at", null)
    .lte("send_at", now.toISOString())
    .order("send_at")
    .limit(10);
  const ids = ((due as { id: string }[]) ?? []).map((r) => r.id);
  if (!ids.length) return { sent: 0 };

  // Claim them first so an overlapping run can't send them twice.
  const { data: claimed } = await supabase
    .from("reminders")
    .update({ sent_at: now.toISOString(), status: "sending" })
    .in("id", ids)
    .is("sent_at", null)
    .select("id, key, title, body, url");
  let sent = 0;
  for (const r of (claimed as { id: string; key: string; title: string; body: string; url: string | null }[]) ?? []) {
    const results = await sendToAll({ title: r.title, body: r.body, url: r.url ?? "/", tag: r.key });
    const ok = results.some((x) => x.result === "ok");
    if (ok) sent++;
    await supabase
      .from("reminders")
      .update({ status: results.length ? (ok ? "sent" : `failed: ${results.map((x) => x.result).join("; ").slice(0, 300)}`) : "no devices" })
      .eq("id", r.id);
  }
  // Housekeeping: forget reminders older than two weeks.
  await supabase.from("reminders").delete().lt("send_at", new Date(now.getTime() - 14 * 86400000).toISOString());
  return { sent };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    let result: Record<string, unknown>;
    switch (body.action) {
      case "config":
        result = { publicKey: (await vapidKeys()).publicKey };
        break;
      case "subscribe": {
        const s = body.subscription;
        if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) throw new Error("subscription is required.");
        const { error } = await supabase.from("push_subscriptions").upsert(
          { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth, user_agent: String(body.userAgent ?? "").slice(0, 300), last_error: null },
          { onConflict: "endpoint" },
        );
        if (error) throw new Error(error.message);
        result = { subscribed: true };
        break;
      }
      case "unsubscribe": {
        if (body.endpoint) await supabase.from("push_subscriptions").delete().eq("endpoint", body.endpoint);
        result = { unsubscribed: true };
        break;
      }
      case "status": {
        const { data } = await supabase.from("push_subscriptions").select("endpoint, last_success_at, last_error");
        const rows = (data as { endpoint: string; last_success_at: string | null; last_error: string | null }[]) ?? [];
        const mine = body.endpoint ? rows.find((r) => r.endpoint === body.endpoint) : undefined;
        result = { devices: rows.length, thisDevice: !!mine, lastSuccess: mine?.last_success_at ?? null, lastError: mine?.last_error ?? null };
        break;
      }
      case "test":
        result = { results: await sendToAll({ title: "Smart Scheduler", body: "Test notification — reminders are working.", url: "/?view=briefing", tag: "test" }) };
        break;
      case "send-due":
        result = await sendDue();
        break;
      default:
        throw new Error("Unknown action.");
    }
    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});



