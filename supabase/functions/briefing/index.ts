/**
 * Briefing helpers for the Smart Scheduler Briefing tab.
 *
 * actions:
 *   weather — forecast for the airports on upcoming flights, for the times
 *             he'll be there. Hourly forecast from Open-Meteo (no key, up to
 *             16 days out) plus the raw TAF / latest METAR from
 *             aviationweather.gov when the stop is close enough for them.
 *   summary — a short written summary of the briefing facts (Groq).
 */
import { AIRPORTS_CSV } from "./airports.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-120b";
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

async function handleSummary(kind: string, facts: string) {
  const system =
    "You write a short briefing for Oshane, an airline First Officer based in MIA who plans his life around seven pillars (Spiritual, Family, Physical, Civ Career, Mil Career, Mental, Financial). " +
    "Using ONLY the facts provided, write 3 to 5 sentences of plain prose (no lists, no headings, no markdown), friendly and direct like a good crew briefing. " +
    "Lead with what matters most for this " + kind + " briefing: the first commitment or departure, flights and any notable weather (thunderstorms, low visibility, strong gusts), goal progress, and heads-ups that need action. " +
    "Use 24-hour times like 07:30. Never invent events, numbers or advice not supported by the facts. Only mention weather if an 'Airport weather' line is in the facts. If there is little going on, say so briefly.";
  const resp = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("GROQ_API_KEY")}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: system }, { role: "user", content: facts.slice(0, 12000) }] }),
  });
  if (!resp.ok) throw new Error(`Summary request failed (${resp.status})`);
  const data = await resp.json();
  const text: string = data.choices?.[0]?.message?.content ?? "";
  return { summary: text.trim() };
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
      result = await handleSummary(String(body.kind ?? "daily"), body.facts);
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

