import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CalendarRange, ClipboardCheck, CloudLightning, Loader2, Plane, RefreshCw, Sparkles, Sunrise, Target } from "lucide-react";
import { getPillarColor } from "@/lib/types";
import { goalShortName } from "@/lib/goalPlanning";
import {
  buildDaily,
  buildMonthly,
  buildWeekly,
  dailyFacts,
  dayLabel,
  defaultBriefingKind,
  factsKey,
  fetchSummary,
  fetchWeather,
  hhmm,
  periodFacts,
  type BriefingKind,
  type DailyBriefing,
  type PeriodBriefing,
  type WeatherResult,
} from "@/lib/briefing";

function readCache(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeCache(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable — the summary just regenerates next time
  }
}

export function BriefingView({ onOpenReview }: { onOpenReview: () => void }) {
  const [kind, setKind] = useState<BriefingKind>(() => defaultBriefingKind());
  const [daily, setDaily] = useState<DailyBriefing | null>(null);
  const [period, setPeriod] = useState<PeriodBriefing | null>(null);
  const [weather, setWeather] = useState<WeatherResult[]>([]);
  const [wxState, setWxState] = useState<"idle" | "loading" | "error">("idle");
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryState, setSummaryState] = useState<"idle" | "loading" | "error">("idle");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const writeSummary = useCallback(async (k: BriefingKind, facts: string, force: boolean) => {
    const key = factsKey(k, facts);
    const cached = force ? null : readCache(key);
    if (cached) {
      setSummary(cached);
      setSummaryState("idle");
      return;
    }
    setSummaryState("loading");
    try {
      const s = await fetchSummary(k, facts);
      setSummary(s);
      writeCache(key, s);
      setSummaryState("idle");
    } catch {
      setSummaryState("error");
    }
  }, []);

  const load = useCallback(
    async (force = false) => {
      setLoading(true);
      setError(null);
      setSummary(null);
      try {
        if (kind === "daily") {
          const b = await buildDaily();
          setDaily(b);
          setPeriod(null);
          setLoading(false);
          let wx: WeatherResult[] = [];
          if (b.weatherStops.length) {
            setWxState("loading");
            try {
              wx = await fetchWeather(b.weatherStops);
              setWxState("idle");
            } catch {
              setWxState("error");
            }
          }
          setWeather(wx);
          await writeSummary("daily", dailyFacts(b, wx, new Date()), force);
        } else {
          const b = kind === "weekly" ? await buildWeekly() : await buildMonthly();
          setPeriod(b);
          setDaily(null);
          setWeather([]);
          setLoading(false);
          await writeSummary(kind, periodFacts(b, new Date()), force);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't build the briefing");
        setLoading(false);
      }
    },
    [kind, writeSummary]
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="max-w-3xl mx-auto w-full p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Sunrise className="w-5 h-5 text-amber-300" />
        <h1 className="text-xl font-semibold text-slate-100">Briefing</h1>
        <div className="ml-auto flex items-center gap-2">
          <div className="flex rounded-lg bg-slate-800 overflow-hidden">
            {(["daily", "weekly", "monthly"] as BriefingKind[]).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors ${kind === k ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                {k}
              </button>
            ))}
          </div>
          <button onClick={() => load(true)} className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700" aria-label="Refresh briefing" title="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {error && <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}

      <div className="mb-4 rounded-xl border border-blue-500/25 bg-blue-500/5 p-4">
        <div className="flex items-center gap-2 mb-1.5 text-xs font-semibold uppercase tracking-wide text-blue-300">
          <Sparkles className="w-3.5 h-3.5" /> Summary
        </div>
        {loading || summaryState === "loading" ? (
          <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Writing your briefing…</div>
        ) : summaryState === "error" || !summary ? (
          <p className="text-sm text-slate-400">The written summary isn't available right now — everything below is complete.</p>
        ) : (
          <p className="text-sm leading-relaxed text-slate-200 whitespace-pre-wrap">{summary}</p>
        )}
      </div>

      {loading ? null : daily ? (
        <Daily b={daily} weather={weather} wxState={wxState} />
      ) : period ? (
        <Period b={period} onOpenReview={onOpenReview} />
      ) : null}
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 rounded-xl border border-slate-700 bg-slate-900/60 p-4">
      <h2 className="flex items-center gap-2 mb-2 text-sm font-semibold text-slate-100">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Daily({ b, weather, wxState }: { b: DailyBriefing; weather: WeatherResult[]; wxState: string }) {
  return (
    <>
      <Section icon={<CalendarRange className="w-4 h-4 text-blue-400" />} title={`Today · ${dayLabel(b.date)}`}>
        {b.utaToday && <div className="mb-2 inline-block rounded-full bg-emerald-600/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">UTA</div>}
        {b.allDay.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {b.allDay.map((i) => (
              <span key={i.id} className="rounded-md bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{i.name}</span>
            ))}
          </div>
        )}
        {b.agenda.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing timed today.</p>
        ) : (
          <ul className="space-y-1">
            {b.agenda.map((i) => {
              const c = getPillarColor(i.pillar);
              return (
                <li key={i.id} className="flex items-center gap-2 text-sm">
                  <span className="w-24 shrink-0 tabular-nums text-slate-400">{hhmm(i.start)}–{hhmm(i.end)}</span>
                  <span className={`w-2 h-2 rounded-full shrink-0 ${c.dot}`} />
                  <span className={`truncate ${i.enroute ? "text-slate-400" : "text-slate-200"}`}>{i.name}</span>
                  {i.goalSession && <Target className="w-3.5 h-3.5 text-blue-300 shrink-0" />}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {(b.weatherStops.length > 0 || weather.length > 0) && (
        <Section icon={<Plane className="w-4 h-4 text-sky-300" />} title="Airport weather">
          {wxState === "loading" ? (
            <div className="flex items-center gap-2 text-sm text-slate-400"><Loader2 className="w-4 h-4 animate-spin" /> Getting forecasts…</div>
          ) : wxState === "error" ? (
            <p className="text-sm text-slate-400">Weather is unavailable right now.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {weather.map((w, i) => <WeatherCard key={`${w.iata}-${i}`} w={w} />)}
            </div>
          )}
          <p className="mt-2 text-[11px] text-slate-500">Forecast: Open-Meteo. TAF/METAR: aviationweather.gov. Not for flight planning — use your dispatch release.</p>
        </Section>
      )}

      {b.goals.length > 0 && (
        <Section icon={<Target className="w-4 h-4 text-blue-300" />} title="Goals this week">
          <ul className="space-y-3">
            {b.goals.map((g) => {
              const c = getPillarColor(g.goal.pillar);
              const pct = g.target ? Math.min(100, Math.round((g.done / g.target) * 100)) : 0;
              return (
                <li key={g.goal.id}>
                  <div className="flex items-center gap-2 text-sm">
                    <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                    <span className="truncate text-slate-200">{goalShortName(g.goal)}</span>
                    <span className="ml-auto tabular-nums text-slate-300">{g.done}/{g.target}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-slate-800">
                    <div className="h-1.5 rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    {g.scheduled} on the calendar this week
                    {g.nextCheckpoint ? ` · next checkpoint: ${g.nextCheckpoint.title} in ${g.nextCheckpoint.daysLeft} day${g.nextCheckpoint.daysLeft === 1 ? "" : "s"}` : ""}
                    {g.deadlineDays !== null ? ` · deadline in ${g.deadlineDays} days` : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <Section icon={<AlertTriangle className="w-4 h-4 text-amber-400" />} title="Heads-up">
        {b.headsUp.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing needs attention.</p>
        ) : (
          <ul className="space-y-1">
            {b.headsUp.map((h, i) => (
              <li key={i} className="text-sm text-amber-100/90">{h}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={<Sunrise className="w-4 h-4 text-amber-300" />} title="Tomorrow">
        <ul className="space-y-1 text-sm text-slate-300">
          {b.utaTomorrow && <li>UTA tomorrow.</li>}
          {b.tomorrow.first ? (
            <li>
              First up: <span className="text-slate-100">{b.tomorrow.first.name}</span> at {hhmm(b.tomorrow.first.start)}
              {b.tomorrow.earlyStart && <span className="text-amber-300"> — early start, prep tonight</span>}
            </li>
          ) : (
            <li>Nothing timed tomorrow.</li>
          )}
          {b.tomorrow.firstFlight && (
            <li>
              First flight: <span className="text-slate-100">{b.tomorrow.firstFlight.name}</span> at {hhmm(b.tomorrow.firstFlight.start)}
              {b.tomorrow.leaveBy && <> · leave by <span className="text-slate-100">{hhmm(b.tomorrow.leaveBy.start)}</span></>}
            </li>
          )}
        </ul>
      </Section>
    </>
  );
}

function WeatherCard({ w }: { w: WeatherResult }) {
  const f = w.forecast;
  const hazards: string[] = [];
  if (f) {
    if (f.code >= 95) hazards.push("Thunderstorms");
    if (f.gustKt >= 25) hazards.push(`Gusts ${f.gustKt} kt`);
    if (f.visSm !== null && f.visSm < 3) hazards.push(`Vis ${f.visSm} sm`);
  }
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-slate-100">
          {w.iata}
          {w.icao && <span className="ml-1 text-xs font-normal text-slate-500">{w.icao}</span>}
        </span>
        <span className="text-xs tabular-nums text-slate-400">
          {dayLabel(new Date(w.from))} {hhmm(new Date(w.from))}–{hhmm(new Date(w.to))}
        </span>
      </div>
      {f ? (
        <>
          <div className="mt-1 flex items-center gap-1.5 text-sm text-slate-200">
            {f.code >= 95 && <CloudLightning className="w-4 h-4 text-amber-300" />}
            {f.condition} · {f.tempMinF === f.tempMaxF ? `${f.tempMaxF}°F` : `${f.tempMinF}–${f.tempMaxF}°F`}
          </div>
          <div className="mt-0.5 text-xs text-slate-400">
            Wind {f.windKt} kt{f.gustKt > f.windKt + 5 ? `, gusts ${f.gustKt}` : ""} · precip {f.precipPct}% · clouds {f.cloudPct}%
            {f.visSm !== null ? ` · vis ${f.visSm >= 10 ? "10+" : f.visSm} sm` : ""}
          </div>
        </>
      ) : (
        <p className="mt-1 text-xs text-slate-500">{w.error === "Unknown airport code" ? "Airport not in the weather list." : "No forecast for this time yet."}</p>
      )}
      {hazards.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {hazards.map((h) => (
            <span key={h} className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-300">{h}</span>
          ))}
        </div>
      )}
      {(w.metar || w.taf) && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-slate-400">METAR / TAF</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-slate-300">
            {[w.metar, w.taf].filter(Boolean).join("\n\n")}
          </pre>
        </details>
      )}
    </div>
  );
}

function Period({ b, onOpenReview }: { b: PeriodBriefing; onOpenReview: () => void }) {
  const back = b.back;
  const ahead = b.ahead;
  return (
    <>
      <Section icon={<ClipboardCheck className="w-4 h-4 text-emerald-300" />} title={`Look back · ${back.label}`}>
        {b.kind === "weekly" && back.goalLines.length > 0 && (
          <ul className="mb-2 space-y-1">
            {back.goalLines.map((g) => (
              <li key={g.goal.id} className="flex items-center gap-2 text-sm">
                <span className={`w-2 h-2 rounded-full ${getPillarColor(g.goal.pillar).dot}`} />
                <span className="truncate text-slate-200">{goalShortName(g.goal)}</span>
                <span className={`ml-auto tabular-nums ${g.held >= g.target ? "text-emerald-300" : "text-amber-300"}`}>{g.held}/{g.target}</span>
                <span className="w-24 text-right text-xs text-slate-500">{g.status ? `review ${g.status}` : "not reviewed"}</span>
              </li>
            ))}
          </ul>
        )}
        {b.kind === "monthly" && back.reviewsByGoal.length > 0 && (
          <ul className="mb-2 space-y-1">
            {back.reviewsByGoal.map((r) => (
              <li key={r.goal.id} className="text-sm text-slate-300">
                <span className="text-slate-200">{goalShortName(r.goal)}</span>: {r.approved} weeks on target, {r.short} short, {r.skipped} skipped
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-slate-300">
          {back.tasksCompleted.length} task{back.tasksCompleted.length === 1 ? "" : "s"} completed
          {back.tasksCompleted.length > 0 && <span className="text-slate-500"> — {back.tasksCompleted.slice(0, 6).join(", ")}{back.tasksCompleted.length > 6 ? "…" : ""}</span>}
        </p>
        {back.checkpointsHit.length > 0 && <p className="mt-1 text-sm text-emerald-300">Checkpoints hit: {back.checkpointsHit.join("; ")}</p>}
        {back.checkpointsMissed.length > 0 && <p className="mt-1 text-sm text-amber-300">Checkpoints missed: {back.checkpointsMissed.join("; ")}</p>}
      </Section>

      <Section icon={<CalendarRange className="w-4 h-4 text-blue-400" />} title={`Look ahead · ${ahead.label}`}>
        <div className="space-y-2 text-sm text-slate-300">
          <div>
            <span className="text-slate-400">Flying: </span>
            {ahead.flightDays.length === 0 ? "no flights" : (
              <ul className="mt-1 space-y-0.5">
                {ahead.flightDays.map((f) => (
                  <li key={f.date.toISOString()} className="tabular-nums">{dayLabel(f.date)} · {f.route}</li>
                ))}
              </ul>
            )}
          </div>
          <div><span className="text-slate-400">UTA: </span>{ahead.utaDays.length ? ahead.utaDays.map(dayLabel).join(", ") : "none"}</div>
          {ahead.busiest && <div><span className="text-slate-400">Busiest day: </span>{dayLabel(ahead.busiest.date)} ({ahead.busiest.hours} h booked)</div>}
          <div>
            <span className="text-slate-400">Deadlines & checkpoints: </span>
            {ahead.deadlines.length === 0 ? "none" : (
              <ul className="mt-1 space-y-0.5">
                {ahead.deadlines.map((d, i) => (
                  <li key={i}>{dayLabel(d.date)} · {d.text}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {b.kind === "weekly" && (
          <button onClick={onOpenReview} className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-500">
            <ClipboardCheck className="w-4 h-4" /> Open the Weekly Review
          </button>
        )}
      </Section>
    </>
  );
}
