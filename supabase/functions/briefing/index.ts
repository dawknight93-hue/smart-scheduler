/**
 * Briefing helpers for the Smart Scheduler Briefing tab.
 *
 * actions:
 *   weather — forecast for the airports on upcoming flights, for the times
 *             he'll be there. Hourly forecast from Open-Meteo (no key, up to
 *             16 days out) plus the raw TAF / latest METAR from
 *             aviationweather.gov when the stop is close enough for them.
 *   summary — a short written summary of the briefing facts (Groq).
 *   parse-tasks — turns a messy to-do list for one day into tasks with a
 *             priority, length, energy, role and any time limits (Plan a day).
 */
import { AIRPORTS_CSV } from "./airports.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b";
// Summaries are written by Claude Sonnet 5 when ANTHROPIC_API_KEY is set; Groq is the fallback.
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-sonnet-5";
const AWC = "https://aviationweather.gov/api/data";
const AWC_HEADERS = { "User-Agent": "SmartScheduler/1.0 (personal crew briefing)" };

interface Airport {
  iata: string;
  icao: string;
  lat: number;
  lon: number;
  tz: string;
}

const airports = new Map<string, Airport>();
for (const line of AIRPORTS_CSV.split("\n")) {
  const [iata, icao, lat, lon, tz] = line.split(",");
  if (iata) airports.set(iata, { iata, icao, lat: Number(lat), lon: Number(lon), tz });
}

interface Stop {
  iata: string;
  from: string; // ISO
  to: string; // ISO
}

// WMO weather interpretation codes (Open-Meteo)
function describeCode(code: number): string {
  if (code === 0) return "Clear";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code >= 95) return "Thunderstorms";
  return "—";
}

// Worse weather wins when summarizing a window.
function severity(code: number): number {
  if (code >= 95) return 9;
  if (code >= 71 && code <= 86) return 8;
  if (code === 45 || code === 48) return 7;
  if (code >= 61 && code <= 67) return 6;
  if (code >= 80 && code <= 82) return 5;
  if (code >= 51 && code <= 57) return 4;
  return code; // 0..3
}

async function forecastFor(ap: Airport, stops: Stop[]) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${ap.lat}&longitude=${ap.lon}` +
    `&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,visibility,cloud_cover` +
    `&temperature_unit=fahrenheit&wind_speed_unit=kn&timezone=GMT&forecast_days=16`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`forecast ${resp.status}`);
  const d = await resp.json();
  const h = d.hourly ?? {};
  const times: number[] = (h.time ?? []).map((t: string) => Date.parse(`${t}:00Z`));
  return stops.map((s) => {
    const from = Math.floor(Date.parse(s.from) / 3600000) * 3600000;
    const to = Date.parse(s.to);
    const idx = times.map((t, i) => [t, i] as const).filter(([t]) => t >= from && t <= to).map(([, i]) => i);
    if (!idx.length) return { ...s, forecast: null };
    const pick = (k: string) => idx.map((i) => h[k]?.[i]).filter((v: unknown) => typeof v === "number") as number[];
    const codes = pick("weather_code");
    const worst = codes.reduce((a, b) => (severity(b) > severity(a) ? b : a), codes[0] ?? 0);
    const temps = pick("temperature_2m");
    const vis = pick("visibility");
    return {
      ...s,
      forecast: {
        condition: describeCode(worst),
        code: worst,
        tempMinF: temps.length ? Math.round(Math.min(...temps)) : null,
        tempMaxF: temps.length ? Math.round(Math.max(...temps)) : null,
        windKt: Math.round(Math.max(0, ...pick("wind_speed_10m"))),
        gustKt: Math.round(Math.max(0, ...pick("wind_gusts_10m"))),
        precipPct: Math.round(Math.max(0, ...pick("precipitation_probability"))),
        visSm: vis.length ? Math.round((Math.min(...vis) / 1609.34) * 10) / 10 : null,
        cloudPct: Math.round(Math.max(0, ...pick("cloud_cover"))),
      },
    };
  });
}

async function awcText(kind: "taf" | "metar", icaos: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!icaos.length) return out;
  try {
    const resp = await fetch(`${AWC}/${kind}?ids=${icaos.join(",")}&format=json${kind === "metar" ? "&hours=2" : ""}`, { headers: AWC_HEADERS });
    if (!resp.ok) return out;
    const rows = (await resp.json()) as { icaoId?: string; rawTAF?: string; rawOb?: string }[];
    for (const r of rows ?? []) {
      const raw = kind === "taf" ? r.rawTAF : r.rawOb;
      // Newest report first per station.
      if (r.icaoId && raw && !out.has(r.icaoId)) out.set(r.icaoId, raw.trim());
    }
  } catch {
    // Aviation weather is a bonus on top of the forecast; never fail the briefing over it.
  }
  return out;
}

async function handleWeather(stops: Stop[]) {
  const now = Date.now();
  const byAirport = new Map<string, Stop[]>();
  const unknown: Stop[] = [];
  for (const s of stops) {
    if (!airports.has(s.iata)) unknown.push(s);
    else byAirport.set(s.iata, [...(byAirport.get(s.iata) ?? []), s]);
  }
  const results: Record<string, unknown>[] = [];
  await Promise.all(
    [...byAirport.entries()].map(async ([iata, list]) => {
      const ap = airports.get(iata)!;
      try {
        for (const r of await forecastFor(ap, list)) results.push({ ...r, icao: ap.icao, tz: ap.tz });
      } catch (e) {
        for (const s of list) results.push({ ...s, icao: ap.icao, tz: ap.tz, forecast: null, error: String(e) });
      }
    })
  );
  // TAFs cover ~24–30 h; METARs are "now". Only ask for stations that are close in time.
  const soon = (s: Stop, hours: number) => Date.parse(s.from) - now < hours * 3600000 && Date.parse(s.to) > now;
  const tafIds = [...new Set(stops.filter((s) => airports.has(s.iata) && soon(s, 30)).map((s) => airports.get(s.iata)!.icao))];
  const metarIds = [...new Set(stops.filter((s) => airports.has(s.iata) && soon(s, 3)).map((s) => airports.get(s.iata)!.icao))];
  const [tafs, metars] = await Promise.all([awcText("taf", tafIds), awcText("metar", metarIds)]);
  for (const r of results) {
    const icao = r.icao as string;
    const s = r as unknown as Stop;
    if (soon(s, 30) && tafs.has(icao)) r.taf = tafs.get(icao);
    if (soon(s, 3) && metars.has(icao)) r.metar = metars.get(icao);
  }
  for (const s of unknown) results.push({ ...s, forecast: null, error: "Unknown airport code" });
  results.sort((a, b) => Date.parse(a.from as string) - Date.parse(b.from as string));
  return { stops: results };
}

async function claudeText(system: string, user: string, key: string): Promise<string> {
  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      // A short summary doesn't need extended reasoning; keeps it fast.
      thinking: { type: "disabled" },
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!resp.ok) throw new Error(`Claude request failed (${resp.status}): ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  // Read text blocks by type, not position.
  return ((data.content ?? []) as { type: string; text?: string }[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

async function groqText(system: string, user: string): Promise<string> {
  const resp = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("GROQ_API_KEY")}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!resp.ok) throw new Error(`Summary request failed (${resp.status})`);
  const data = await resp.json();
  return String(data.choices?.[0]?.message?.content ?? "").trim();
}

type Who = { name?: string; about?: string; roles?: string[] };
async function handleSummary(kind: string, facts: string, memory: string[], retryNote: string | null, who: Who = {}) {
  // Who the briefing is for, from this copy's settings (the app sends it); defaults are the original owner.
  const name = who.name?.trim() || "Oshane";
  const about = who.about !== undefined ? who.about.trim() : "an airline First Officer based in MIA";
  const roles = who.roles?.length ? who.roles : ["Spiritual", "Family", "Physical", "Civ Career", "Mil Career", "Mental", "Financial"];
  const system =
    "You write a short briefing for " + name + (about ? ", " + about + "," : "") + " who plans their life around " + roles.length + " roles (" + roles.join(", ") + "). " +
    "Using ONLY the facts provided, write 3 to 5 sentences of plain prose (no lists, no headings, no markdown), friendly and direct like a good crew briefing. " +
    "Lead with what matters most for this " + kind + " briefing: the first commitment or departure, flights and any notable weather (thunderstorms, low visibility, strong gusts), goal progress, and heads-ups that need action. " +
    "Use 24-hour times like 07:30. Never invent events, numbers or advice not supported by the facts. Only mention weather if an 'Airport weather' line is in the facts. If there is little going on, say so briefly. " +
    "Situational-awareness facts come from info-only calendars: they are context and actions, never booked time or commitments. When they include a reserve day, proffer window, assignment timing, open-time or bid window, payday or bill, weave the most important one into a sentence that starts 'For your situational awareness,' and keep its exact times and actions. " +
    "For weekly and monthly briefings, use the duty-day counts to say how the period went and what it means for the month (for example, reserve days with no flying count toward their days off). " +
    "Every time, date and number you write must appear in the facts exactly; if you're not sure, leave it out." +
    (memory.length
      ? "\n\nTheir standing corrections from earlier briefings — always follow these:\n" + memory.map((m) => `- ${m}`).join("\n")
      : "");
  const user = facts.slice(0, 16000) + (retryNote ? `\n\nYOUR PREVIOUS DRAFT HAD PROBLEMS. Rewrite the whole summary and drop or fix these sentences (only use times, dates and numbers that appear in the facts):\n${retryNote}` : "");
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (key) {
    try {
      return { summary: await claudeText(system, user, key), model: "Claude Sonnet 5" };
    } catch (e) {
      console.error(e);
      // Fall through to Groq so the Briefing still has a summary.
      return { summary: await groqText(system, user), model: "Groq gpt-oss-120b (Claude unavailable)", warning: String(e).slice(0, 200) };
    }
  }
  return { summary: await groqText(system, user), model: "Groq gpt-oss-120b (Claude key not set)" };
}

// ---- Plan a day: read a messy list ------------------------------------------

type ParsedTask = {
  name: string;
  tier: number;
  duration_min: number;
  effort: "focus" | "routine" | "light";
  pillar: string | null;
  context: "desk" | "home" | "phone" | "errand" | "other";
  not_before: string | null;
  due_by: string | null;
  note: string | null;
};

const EFFORTS = ["focus", "routine", "light"];
const CONTEXTS = ["desk", "home", "phone", "errand", "other"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function firstJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The AI didn't return a task list.");
  return JSON.parse(text.slice(start, end + 1));
}

function cleanTasks(raw: unknown, roleKeys: string[]): ParsedTask[] {
  const list = (raw as { tasks?: unknown[] })?.tasks;
  if (!Array.isArray(list)) throw new Error("The AI didn't return a task list.");
  const out: ParsedTask[] = [];
  for (const r of list.slice(0, 40)) {
    const t = r as Record<string, unknown>;
    const name = typeof t.name === "string" ? t.name.trim().slice(0, 120) : "";
    if (!name) continue;
    const tier = Math.min(4, Math.max(1, Math.round(Number(t.tier) || 3)));
    const dur = Math.min(480, Math.max(5, Math.round((Number(t.duration_min) || 30) / 5) * 5));
    const effort = EFFORTS.includes(String(t.effort)) ? (t.effort as ParsedTask["effort"]) : "routine";
    const context = CONTEXTS.includes(String(t.context)) ? (t.context as ParsedTask["context"]) : "other";
    const pillar = typeof t.pillar === "string" && roleKeys.includes(t.pillar) ? t.pillar : null;
    const nb = typeof t.not_before === "string" && HHMM.test(t.not_before) ? t.not_before : null;
    const db = typeof t.due_by === "string" && HHMM.test(t.due_by) ? t.due_by : null;
    const note = typeof t.note === "string" && t.note.trim() ? t.note.trim().slice(0, 140) : null;
    out.push({ name, tier, duration_min: dur, effort, pillar, context, not_before: nb, due_by: db, note });
  }
  return out;
}

async function handleParseTasks(body: Record<string, unknown>) {
  const text = String(body.text ?? "").slice(0, 4000);
  if (!text.trim()) throw new Error("Type a few tasks first.");
  const day = String(body.day ?? "");
  const roles = Array.isArray(body.roles)
    ? (body.roles as { key?: unknown; label?: unknown }[])
        .filter((r) => typeof r?.key === "string" && typeof r?.label === "string")
        .slice(0, 7)
        .map((r) => ({ key: String(r.key), label: String(r.label).slice(0, 40) }))
    : [];
  const events = Array.isArray(body.events) ? (body.events as unknown[]).filter((e) => typeof e === "string").slice(0, 40).map((e) => String(e).slice(0, 120)) : [];
  const about = typeof body.about === "string" ? body.about.slice(0, 400) : "";
  const quiet = typeof body.quiet === "string" ? body.quiet.slice(0, 20) : "";

  const system =
    "You turn a person's messy to-do list for one day into structured tasks for their planner. Reply with JSON only, no prose: " +
    '{"tasks":[{"name":string,"tier":1|2|3|4,"duration_min":number,"effort":"focus"|"routine"|"light","pillar":string|null,"context":"desk"|"home"|"phone"|"errand"|"other","not_before":"HH:MM"|null,"due_by":"HH:MM"|null,"note":string|null}]}. ' +
    "One task per item they listed, in their order; split a line only if it clearly holds two separate tasks, never invent tasks. " +
    "name: short and clear, in title-like sentence case, keep their meaning and any names. " +
    "tier: 1 = critical (urgent, must, today, deadline), 2 = high (important or tied to a commitment), 3 = medium (the default), 4 = low ('if there's time', 'maybe', 'someday'). " +
    "duration_min: use any length they gave; otherwise a realistic estimate in multiples of 5 (quick call or email 10–15, errand 30–45, focused work 60–90). " +
    "effort: focus = needs deep concentration (study, writing, planning, bids, analysis); light = easy or mindless (errands, chores, quick messages); routine = everything else. " +
    "pillar: the key of the best-fitting role from this list, or null if none fits: " + (roles.map((r) => `${r.key} (${r.label})`).join(", ") || "none") + ". " +
    "context: phone for calls, errand for anything away from home (stores, pickups, appointments out), desk for computer work, home for chores at home, else other. " +
    "not_before / due_by: 24-hour local times only when the list or their calendar clearly requires it (e.g. prep that must be done before a meeting gets due_by that meeting's start; 'after lunch' gets not_before 13:00; business calls get not_before 09:00 and due_by 17:00). Otherwise null. " +
    "note: at most 12 words explaining a non-obvious choice (why a priority, a time limit, or a missing due date), else null.";
  const user =
    `Day: ${day}` +
    (about ? `\nAbout them: ${about}` : "") +
    (quiet ? `\nThey don't schedule anything during quiet hours ${quiet}.` : "") +
    (events.length ? `\nAlready on their calendar that day:\n${events.map((e) => "- " + e).join("\n")}` : "\nNothing else is on their calendar that day.") +
    `\n\nTheir list:\n${text}`;

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  let raw: string;
  let model: string;
  if (key) {
    try {
      raw = await claudeText(system, user, key);
      model = "Claude Sonnet 5";
    } catch (e) {
      console.error(e);
      raw = await groqText(system, user);
      model = "Groq gpt-oss-120b (Claude unavailable)";
    }
  } else {
    raw = await groqText(system, user);
    model = "Groq gpt-oss-120b";
  }
  return { tasks: cleanTasks(firstJson(raw), roles.map((r) => r.key)), model };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const body = await req.json();
    let result: Record<string, unknown>;
    if (body.action === "weather") {
      if (!Array.isArray(body.stops)) throw new Error("stops is required.");
      result = await handleWeather(body.stops.slice(0, 40));
    } else if (body.action === "summary") {
      if (typeof body.facts !== "string") throw new Error("facts is required.");
      const memory = Array.isArray(body.memory) ? body.memory.filter((m: unknown) => typeof m === "string" && m.trim()).slice(0, 40).map((m: string) => m.slice(0, 300)) : [];
      const who: Who = body.who && typeof body.who === "object" ? {
        name: typeof body.who.name === "string" ? body.who.name.slice(0, 80) : undefined,
        about: typeof body.who.about === "string" ? body.who.about.slice(0, 400) : undefined,
        roles: Array.isArray(body.who.roles) ? body.who.roles.filter((r: unknown) => typeof r === "string").slice(0, 7).map((r: string) => r.slice(0, 40)) : undefined,
      } : {};
      result = await handleSummary(String(body.kind ?? "daily"), body.facts, memory, typeof body.retryNote === "string" ? body.retryNote.slice(0, 1500) : null, who);
    } else if (body.action === "parse-tasks") {
      result = await handleParseTasks(body);
    } else {
      throw new Error("Unknown action.");
    }
    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});




