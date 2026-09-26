import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, SlidersHorizontal, CalendarRange, ClipboardCheck, CloudLightning, DollarSign, Heart, Info, Loader2, Plane, Radar, RefreshCw, ShieldCheck, Sparkles, Sunrise, Target, ThumbsDown, ThumbsUp, BookOpen, Bell } from "lucide-react";
import type { AwarenessNote, AwareItem, DailyAwareness, DutyStats } from "@/lib/awareness";
import { AwarenessRulesEditor } from "@/components/AwarenessRulesEditor";
import { BriefingMemoryEditor } from "@/components/BriefingMemoryEditor";
import { RemindersPanel } from "@/components/RemindersPanel";
import { OutcomeTracker } from "@/components/MeasureWidgets";
import { fmt, outcomeStatus, planKey } from "@/lib/measures";
import { addMemory, loadMemory } from "@/lib/briefingMemory";
import { getPillarColor } from "@/lib/types";
import { goalShortName } from "@/lib/goalPlanning";
import { getWeekStart } from "@/lib/schedulingEngine";
import { setCountedDone, setSessionDone, type DayEntry } from "@/lib/goalDaily";
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
  sessionNoun,
  type BriefingKind,
  type DailyBriefing,
  type PeriodBriefing,
  type SummaryResult,
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
  // Awareness rules editor: closed, open, or open with a new rule drafted from an event.
  const [rulesEditor, setRulesEditor] = useState<{ draft: { title: string; source?: string } | null } | null>(null);
  const [daily, setDaily] = useState<DailyBriefing | null>(null);
  const [period, setPeriod] = useState<PeriodBriefing | null>(null);
  const [weather, setWeather] = useState<WeatherResult[]>([]);
  const [wxState, setWxState] = useState<"idle" | "loading" | "error">("idle");
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  // Feedback on the current summary: null, "up" (thanks shown), or "down" (note input open).
  const [feedback, setFeedback] = useState<null | "up" | "down" | "saved">(null);
  const [feedbackNote, setFeedbackNote] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const lastFacts = useRef<{ kind: BriefingKind; facts: string } | null>(null);
  const [summaryState, setSummaryState] = useState<"idle" | "loading" | "error">("idle");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const writeSummary = useCallback(async (k: BriefingKind, facts: string, force: boolean) => {
    lastFacts.current = { kind: k, facts };
    setFeedback(null);
    setFeedbackNote("");
    setFeedbackError(null);
    const memory = (await loadMemory()).filter((n) => n.active).map((n) => n.note);
    setMemoryCount(memory.length);
    const key = factsKey(k, facts, memory);
    const cached = force ? null : readCache(key);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as SummaryResult;
        if (parsed && typeof parsed.text === "string") {
          setSummary(parsed);
          setSummaryState("idle");
          return;
        }
      } catch {
        // old or damaged cache entry — write a fresh summary
      }
    }
    setSummaryState("loading");
    try {
      const s = await fetchSummary(k, facts, memory);
      setSummary(s);
      if (s.text) writeCache(key, JSON.stringify(s));
      setSummaryState("idle");
    } catch {
      setSummaryState("error");
    }
  }, []);

  async function saveFeedback() {
    const note = feedbackNote.trim();
    if (!note || !summary || !lastFacts.current) return;
    setFeedbackBusy(true);
    setFeedbackError(null);
    try {
      await addMemory(note, "feedback", lastFacts.current.kind, summary.text);
      setFeedback("saved");
      const { kind: k, facts } = lastFacts.current;
      await writeSummary(k, facts, true);
      setFeedback("saved");
    } catch (e) {
      setFeedbackError(e instanceof Error ? e.message : "Couldn't save the note");
    } finally {
      setFeedbackBusy(false);
    }
  }

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
          <button onClick={() => setRemindersOpen(true)} className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-slate-800 text-xs text-slate-300 hover:bg-slate-700" title="Push reminders on this phone">
            <Bell className="w-3.5 h-3.5" /> Reminders
          </button>
          <button onClick={() => setMemoryOpen(true)} className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-slate-800 text-xs text-slate-300 hover:bg-slate-700" title="What the summary writer remembers">
            <BookOpen className="w-3.5 h-3.5" /> Memory{memoryCount !== null ? ` (${memoryCount})` : ""}
          </button>
          <button onClick={() => setRulesEditor({ draft: null })} className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-slate-800 text-xs text-slate-300 hover:bg-slate-700" title="Awareness rules">
            <SlidersHorizontal className="w-3.5 h-3.5" /> Rules
          </button>
          <button onClick={() => load(true)} className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700" aria-label="Refresh briefing" title="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {rulesEditor && (
        <AwarenessRulesEditor
          draft={rulesEditor.draft}
          onClose={(changed) => {
            setRulesEditor(null);
            if (changed) void load(false);
          }}
        />
      )}

      {remindersOpen && <RemindersPanel onClose={() => setRemindersOpen(false)} />}

      {memoryOpen && (
        <BriefingMemoryEditor
          onClose={(changed) => {
            setMemoryOpen(false);
            if (changed) void load(false);
          }}
        />
      )}

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
          <>
            {summary.text ? (
              <p className="text-sm leading-relaxed text-slate-200 whitespace-pre-wrap">{summary.text}</p>
            ) : (
              <p className="text-sm text-slate-400">Every sentence in the summary failed the fact-check, so none is shown — everything below is complete.</p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-slate-500">
              <span>Written by {summary.model}</span>
              <span className="flex items-center gap-1">
                <ShieldCheck className="w-3 h-3" />
                {summary.removed.length
                  ? `Fact-check removed ${summary.removed.length} sentence${summary.removed.length === 1 ? "" : "s"}`
                  : summary.retried
                    ? "Fact-checked — fixed on rewrite"
                    : "Fact-checked"}
              </span>
              <span className="ml-auto flex items-center gap-1">
                {feedback === "saved" ? (
                  <span className="text-emerald-400">Saved to memory — rewritten with it</span>
                ) : feedback === "up" ? (
                  <span className="text-emerald-400">Thanks</span>
                ) : (
                  <>
                    <button onClick={() => setFeedback("up")} className="p-1 rounded hover:bg-slate-800" aria-label="Good summary" title="Good summary">
                      <ThumbsUp className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setFeedback(feedback === "down" ? null : "down")} className={`p-1 rounded hover:bg-slate-800 ${feedback === "down" ? "text-rose-300" : ""}`} aria-label="Something's wrong" title="Something's wrong — tell it what to fix">
                      <ThumbsDown className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </span>
            </div>
            {summary.removed.length > 0 && (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-[11px] text-slate-400">What was removed and why</summary>
                <ul className="mt-1 space-y-1">
                  {summary.removed.map((r, i) => (
                    <li key={i} className="text-[11px] text-slate-400">
                      <span className="line-through text-slate-500">{r.sentence}</span> — {r.reasons.join("; ")}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {summary.warning && <p className="mt-1 text-[11px] text-amber-400/80">Claude error: {summary.warning}</p>}
            {feedback === "down" && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-slate-400">What should it do differently? This is saved to memory and used in every summary from now on.</p>
                <textarea
                  value={feedbackNote}
                  onChange={(e) => setFeedbackNote(e.target.value)}
                  rows={2}
                  placeholder="e.g. “My first item is the 07:30 gym session, not Jatara's appointment.”"
                  className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
                />
                {feedbackError && <p className="text-xs text-rose-300">{feedbackError}</p>}
                <div className="flex justify-end gap-2">
                  <button onClick={() => setFeedback(null)} className="px-3 py-1 rounded-lg text-xs text-slate-300 hover:bg-slate-800">Cancel</button>
                  <button disabled={feedbackBusy || !feedbackNote.trim()} onClick={() => void saveFeedback()} className="flex items-center gap-1 px-3 py-1 rounded-lg bg-blue-600 text-xs text-white disabled:opacity-50">
                    {feedbackBusy && <Loader2 className="w-3 h-3 animate-spin" />} Save and rewrite
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {loading ? null : daily ? (
        <Daily b={daily} weather={weather} wxState={wxState} onChange={setDaily} onAddRule={(i) => setRulesEditor({ draft: { title: i.name, source: i.source } })} />
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

function Daily({
  b,
  weather,
  wxState,
  onChange,
  onAddRule,
}: {
  b: DailyBriefing;
  weather: WeatherResult[];
  wxState: string;
  onChange: (b: DailyBriefing) => void;
  onAddRule: (i: AwareItem) => void;
}) {
  const [tickError, setTickError] = useState<string | null>(null);
  async function tick(key: string, e: DayEntry, done: boolean) {
    const g = b.goals.find((x) => planKey(x.goal) === key);
    if (!g) return;
    setTickError(null);
    try {
      const weekStart = getWeekStart(b.date);
      if (e.counted) await setCountedDone(g.goal, e.counted, weekStart, done);
      else if (e.habitId && e.start) await setSessionDone(g.goal, { item: e.item, habitId: e.habitId, start: e.start, minutes: e.minutes }, weekStart, done);
      // Update in place; the written summary refreshes next time the briefing opens.
      onChange({
        ...b,
        goals: b.goals.map((x) =>
          planKey(x.goal) !== key
            ? x
            : { ...x, done: x.done + (done === e.done ? 0 : done ? 1 : -1), today: x.today.map((t) => (t.key === e.key ? { ...t, done } : t)) }
        ),
      });
    } catch (err) {
      setTickError(err instanceof Error ? err.message : "Couldn't save");
    }
  }
  return (
    <>
      <AwarenessCard a={b.awareness} onAddRule={onAddRule} />

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
                  <span className={`truncate ${i.enroute || i.blocks === false ? "text-slate-400" : "text-slate-200"}`}>{i.name}</span>
                  {i.blocks === false && !i.flight && (
                    <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400" title="From an info-only calendar — doesn't hold time">info</span>
                  )}
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

      {(b.goals.length > 0 || b.outcomes.length > 0) && (
        <Section icon={<Target className="w-4 h-4 text-blue-300" />} title="Goals this week">
          {tickError && <p className="mb-2 text-xs text-rose-300">{tickError}</p>}
          <ul className="space-y-3">
            {b.goals.map((g) => {
              const c = getPillarColor(g.goal.pillar);
              const pct = g.target ? Math.min(100, Math.round((g.done / g.target) * 100)) : 0;
              return (
                <li key={planKey(g.goal)}>
                  <div className="flex items-center gap-2 text-sm">
                    <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                    <span className="truncate text-slate-200">
                      {goalShortName(g.goal)}
                      {g.goal.measure_label && <span className="text-slate-400"> · {g.goal.measure_label}</span>}
                    </span>
                    <span className="ml-auto tabular-nums text-slate-300">{g.done}/{g.target}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-slate-800">
                    <div className="h-1.5 rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                  </div>
                  {g.today.length > 0 && (
                    <ul className="mt-1.5 space-y-1">
                      {g.today.map((e) => (
                        <li key={e.key} className="flex items-start gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={e.done}
                            onChange={(ev) => tick(planKey(g.goal), e, ev.target.checked)}
                            className="mt-1 accent-emerald-500"
                            aria-label={`Mark ${e.focus ?? e.title} done`}
                          />
                          <span className="w-12 shrink-0 tabular-nums text-slate-400">{e.start ? hhmm(e.start) : "all day"}</span>
                          <span className="min-w-0">
                            <span className={e.done ? "text-slate-500 line-through" : "text-slate-100"}>{e.focus ?? e.title}</span>
                            {e.steps.length > 0 && !e.done && <span className="block text-xs text-slate-500">{e.steps.join(" · ")}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-1 text-xs text-slate-400">
                    {g.done} ticked done · {g.scheduled} on the calendar this week
                    {g.nextCheckpoint ? ` · next checkpoint: ${g.nextCheckpoint.title} in ${g.nextCheckpoint.daysLeft} day${g.nextCheckpoint.daysLeft === 1 ? "" : "s"}` : ""}
                    {g.deadlineDays !== null ? ` · deadline in ${g.deadlineDays} days` : ""}
                  </p>
                </li>
              );
            })}
          </ul>
          {b.outcomes.length > 0 && (
            <div className={`${b.goals.length ? "mt-3 border-t border-slate-800 pt-3" : ""} space-y-2`}>
              <p className="text-[11px] uppercase tracking-wide text-slate-500">Numbers you log</p>
              {b.outcomes.map((o) => (
                <OutcomeTracker
                  key={o.measure.id}
                  measure={o.measure}
                  entries={o.status.entries}
                  onChange={(es) =>
                    onChange({ ...b, outcomes: b.outcomes.map((x) => (x.measure.id === o.measure.id ? { ...x, status: outcomeStatus(x.measure, es) } : x)) })
                  }
                />
              ))}
              <p className="text-[11px] text-slate-500">A new number shows up in the summary the next time the briefing loads.</p>
            </div>
          )}
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
              <li key={planKey(g.goal)} className="flex items-center gap-2 text-sm">
                <span className={`w-2 h-2 rounded-full ${getPillarColor(g.goal.pillar).dot}`} />
                <span className="truncate text-slate-200">
                  {goalShortName(g.goal)}
                  {g.goal.measure_label && <span className="text-slate-400"> · {g.goal.measure_label}</span>}
                </span>
                <span className="ml-auto tabular-nums text-xs text-slate-400" title="Sessions on the calendar">
                  {g.held} of {g.target} {sessionNoun(g.goal)} on the calendar
                </span>
                {g.tracked ? (
                  <span className={`tabular-nums ${g.done >= g.target ? "text-emerald-300" : "text-amber-300"}`} title="Sessions you ticked done">{g.done} ticked done</span>
                ) : (
                  <span className="text-xs text-slate-500" title="Done-ticks started the week of 21 Sep">done not tracked yet</span>
                )}
                <span className="w-24 text-right text-xs text-slate-500">{g.status ? `review ${g.status}` : "not reviewed"}</span>
              </li>
            ))}
          </ul>
        )}
        {back.outcomes.length > 0 && (
          <ul className="mb-2 space-y-1">
            {back.outcomes.map((o) => {
              const st = o.status;
              const unit = o.measure.unit ? ` ${o.measure.unit}` : "";
              return (
                <li key={o.measure.id} className="flex items-center gap-2 text-sm">
                  <span className={`w-2 h-2 rounded-full ${getPillarColor(o.goal.pillar).dot}`} />
                  <span className="truncate text-slate-200">{o.measure.label}</span>
                  <span className="ml-auto tabular-nums text-xs text-slate-400">
                    {st.latest ? `${fmt(st.latest.value)}${unit}` : "nothing logged"}
                    {st.change !== null && o.measure.baseline !== null ? ` (${st.change >= 0 ? "+" : ""}${fmt(Math.round(st.change * 10) / 10)} since start)` : ""}
                  </span>
                  {st.next && st.onTrack !== null && (
                    <span className={`w-24 text-right text-xs ${st.onTrack ? "text-emerald-300" : "text-amber-300"}`}>{st.onTrack ? "on track" : "behind"}</span>
                  )}
                </li>
              );
            })}
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
        <DutyLine label="Duty days" stats={back.duty.stats} sentence={back.duty.sentence} />
        {back.duty.month && <DutyLine label={back.duty.month.label} stats={back.duty.month.stats} sentence={back.duty.month.sentence} muted />}
        <p className="mt-2 text-sm text-slate-300">
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
          <DutyLine label="Duty days" stats={ahead.duty.stats} sentence={ahead.duty.sentence} />
          {ahead.markers.length > 0 && (
            <div>
              <span className="text-slate-400">For your awareness: </span>
              <ul className="mt-1 space-y-0.5">
                {ahead.markers.map((m, i) => (
                  <li key={i} className="tabular-nums">{dayLabel(m.date)} · {m.text}</li>
                ))}
              </ul>
            </div>
          )}
          {ahead.busiest && (
            <div>
              <span className="text-slate-400">Busiest day: </span>
              {dayLabel(ahead.busiest.date)} ({ahead.busiest.hours} h booked)
              {ahead.busiest.items.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-slate-400">
                  {ahead.busiest.items.map((i, k) => (
                    <li key={k} className="tabular-nums">
                      {hhmm(i.start)}–{hhmm(i.end)} · <span className="text-slate-300">{i.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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

const TONE_ICON: Record<AwarenessNote["tone"], React.ReactNode> = {
  duty: <Plane className="w-3.5 h-3.5 text-sky-300" />,
  money: <DollarSign className="w-3.5 h-3.5 text-emerald-300" />,
  family: <Heart className="w-3.5 h-3.5 text-rose-300" />,
  info: <Info className="w-3.5 h-3.5 text-slate-400" />,
};

/** Info-only calendars (Informational, Jatara's) turned into notes and actions. */
function AwarenessCard({ a, onAddRule }: { a: DailyAwareness; onAddRule: (i: AwareItem) => void }) {
  if (!a.notes.length && !a.fyi.length && !a.comingUp.length) return null;
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return (
    <section className="mb-4 rounded-xl border border-sky-500/25 bg-sky-500/5 p-4">
      <h2 className="flex items-center gap-2 mb-2 text-sm font-semibold text-slate-100">
        <Radar className="w-4 h-4 text-sky-300" />
        Situational awareness
        <span className="text-[11px] font-normal text-slate-500">info only · doesn't hold time</span>
      </h2>
      <ul className="space-y-2">
        {a.notes.map((n, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 shrink-0">{TONE_ICON[n.tone]}</span>
            <span>
              <span className="text-slate-100">{n.text}</span>
              {n.action && <span className="block text-amber-200/90">{n.action}</span>}
            </span>
          </li>
        ))}
        {a.fyi.map(({ item: f, noRule }, i) => (
          <li key={`fyi-${i}`} className="flex items-start gap-2 text-sm text-slate-300">
            <span className="mt-0.5 shrink-0">{TONE_ICON.info}</span>
            <span>
              {f.name.replace(/^[\s,]+/, "")}
              <span className="text-slate-500"> · {f.allDay ? "all day" : `${hhmm(f.start)}–${hhmm(f.end)}`}{f.source ? ` · ${f.source}` : ""}</span>
              {noRule && (
                <button onClick={() => onAddRule(f)} className="ml-2 text-xs text-blue-400 hover:underline">
                  No rule yet · add one
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {a.comingUp.length > 0 && (
        <p className="mt-3 text-xs text-slate-400">
          <span className="text-slate-500">Coming up: </span>
          {a.comingUp.join(" · ")}
        </p>
      )}
    </section>
  );
}

function DutyLine({ label, stats, sentence, muted }: { label: string; stats: DutyStats; sentence: string; muted?: boolean }) {
  return (
    <div className={`mb-1 text-sm ${muted ? "text-slate-400" : "text-slate-300"}`}>
      <span className="text-slate-400">{label}: </span>
      {sentence}
      {!muted && stats.days > 0 && (
        <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-slate-800" title={`${stats.flying} flying · ${stats.reserveUnflown} unflown reserve · ${stats.uta} UTA · ${stats.clearOff} off`}>
          <div className="bg-sky-500" style={{ width: `${(stats.flying / stats.days) * 100}%` }} />
          <div className="bg-violet-500/70" style={{ width: `${(stats.reserveUnflown / stats.days) * 100}%` }} />
          <div className="bg-emerald-600/70" style={{ width: `${(stats.uta / stats.days) * 100}%` }} />
          <div className="bg-slate-600" style={{ width: `${(stats.clearOff / stats.days) * 100}%` }} />
        </div>
      )}
    </div>
  );
}
