import { useEffect, useMemo, useState, type ReactElement } from "react";
import { ArrowDown, ArrowUp, Check, Loader2, Plus, Trash2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { appSettings, type AppFeatures } from "@/lib/appSettings";
import { saveAppSettings } from "@/lib/appSettingsLoader";
import { createGoogleCalendar, getOAuthUrl, getSyncStatus, isGoogleConfigured, listGoogleCalendars, type GoogleCalendarInfo } from "@/lib/gcalSync";
import { deleteDayRoutine, loadDayRoutines, saveDayRoutine, STARTER_ROUTINES, type DayRoutine, type RoutineWindow } from "@/lib/dayRoutines";
import type { LifePillar } from "@/lib/types";

/**
 * First-time setup: who this copy is for. Shown on a copy that hasn't been set
 * up yet, or at ?setup=preview (a dry run that saves nothing).
 *
 * Everything asked here maps onto what the app already uses: calendar roles,
 * role names, recurring blocks, day routines, quiet hours, feature switches
 * and goals. Answers are kept on the device while you go, so leaving to
 * connect Google (or a reload) picks up where you left off.
 */

type CalChoice = "block" | "show" | "ignore";
interface Win {
  from: string;
  to: string;
}
interface WeeklyBlock {
  name: string;
  days: number[];
  from: string;
  to: string;
}
interface Draft {
  step: number;
  name: string;
  about: string;
  tz: string;
  calRoles: Record<string, CalChoice>;
  planCal: string; // a calendar id, or NEW_CAL
  roles: string[];
  works: boolean;
  workDays: number[];
  workFrom: string;
  workTo: string;
  commute: number;
  blocks: WeeklyBlock[];
  workWindows: Win[];
  offWindows: Win[];
  quietStart: number;
  quietEnd: number;
  features: AppFeatures;
  goals: { text: string; role: string }[];
}

const NEW_CAL = "__new__";
const NEW_CAL_NAME = "My Planner";
const DRAFT_KEY = "smartScheduler.setupDraft";
const MAX_ROLES = 7;
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const ZONES: [string, string][] = [
  ["America/New_York", "Eastern time"],
  ["America/Chicago", "Central time"],
  ["America/Denver", "Mountain time"],
  ["America/Phoenix", "Arizona time"],
  ["America/Los_Angeles", "Pacific time"],
  ["America/Anchorage", "Alaska time"],
  ["Pacific/Honolulu", "Hawaii time"],
];
const zoneLabel = (z: string) => ZONES.find(([k]) => k === z)?.[1] ?? `${z.split("/").pop()?.replace(/_/g, " ")} time`;
const deviceZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
  } catch {
    return "America/New_York";
  }
})();

const ROLE_IDEAS = ["Family", "Mom", "Wife", "Work", "Health", "Faith", "Home", "Friends", "Money", "Personal growth", "Rest"];

/** The 7 built-in role slots, and words that fit each (so "Faith" lands on the faith slot, etc.). */
const SLOTS: [LifePillar, RegExp][] = [
  ["spiritual", /faith|church|god|spirit|pray|worship|bible|ministry/i],
  ["physical", /health|fitness|body|exercise|run|gym|well/i],
  ["financial", /money|financ|budget|wealth|invest|business/i],
  ["mental", /mind|mental|rest|self|growth|learn|read|peace|hobb/i],
  ["family", /family|mom|mother|dad|father|wife|husband|kid|child|parent|spouse|marri/i],
  ["civ_career", /work|career|job|office|nurs|teach|school/i],
  ["mil_career", /military|reserve|guard|service|side|second/i],
];

/** Puts each chosen role name on one of the 7 built-in role slots. */
export function assignRoleSlots(names: string[]): { labels: Record<string, string>; order: LifePillar[] } {
  const taken = new Map<LifePillar, string>();
  const left: string[] = [];
  for (const n of names) {
    const slot = SLOTS.find(([k, re]) => !taken.has(k) && re.test(n));
    if (slot) taken.set(slot[0], n);
    else left.push(n);
  }
  for (const n of left) {
    const free = SLOTS.find(([k]) => !taken.has(k));
    if (free) taken.set(free[0], n);
  }
  const byName = new Map([...taken].map(([k, n]) => [n, k]));
  const order = names.map((n) => byName.get(n)).filter((k): k is LifePillar => !!k);
  return { labels: Object.fromEntries(taken), order };
}

function freshDraft(): Draft {
  return {
    step: 0,
    name: appSettings.displayName,
    about: "",
    tz: ZONES.some(([z]) => z === deviceZone) ? deviceZone : "America/New_York",
    calRoles: {},
    planCal: NEW_CAL,
    roles: ["Family", "Work", "Health", "Faith"],
    works: true,
    workDays: [1, 2, 3, 4, 5],
    workFrom: "08:30",
    workTo: "17:00",
    commute: 20,
    blocks: [],
    workWindows: [
      { from: "06:00", to: "07:30" },
      { from: "19:00", to: "21:00" },
    ],
    offWindows: [
      { from: "09:00", to: "12:00" },
      { from: "14:00", to: "18:00" },
    ],
    quietStart: 21,
    quietEnd: 6,
    features: { trips: false, drill: false, fitnessApp: false, bookingPage: false, briefing: true, weeklyReview: true },
    goals: [{ text: "", role: "Health" }],
  };
}

function loadDraft(): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return { ...freshDraft(), ...(JSON.parse(raw) as Partial<Draft>) };
  } catch {
    /* no saved draft */
  }
  return freshDraft();
}

const field = "rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-sm text-slate-100";
const chip = (on: boolean) =>
  `rounded-full border px-3 py-1.5 text-sm transition-colors ${on ? "border-blue-500 bg-blue-600 text-white" : "border-slate-700 bg-slate-800 text-slate-200 hover:border-slate-500"}`;
const hint = "text-xs text-slate-500 mt-1";
const q = "block text-sm font-semibold text-slate-200 mt-5 mb-1.5";
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const hourText = (h: number) => `${String(h).padStart(2, "0")}:00`;

export function SetupWizard({ preview, onClose }: { preview: boolean; onClose: () => void }) {
  const [d, setD] = useState<Draft>(loadDraft);
  const [connected, setConnected] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [cals, setCals] = useState<GoogleCalendarInfo[] | null>(null);
  const [calError, setCalError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [previewDone, setPreviewDone] = useState(false);
  const [newRole, setNewRole] = useState("");

  const set = (patch: Partial<Draft>) =>
    setD((cur) => {
      const next = { ...cur, ...patch };
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable: answers live in memory only */
      }
      return next;
    });

  async function checkGoogle() {
    setChecking(true);
    setCalError(null);
    try {
      const status = await getSyncStatus();
      setConnected(status?.connected ? status.email ?? "your Google account" : null);
      if (status?.connected) {
        const r = await listGoogleCalendars();
        if (r.error) setCalError(r.error);
        setCals(r.calendars);
        // Sensible first answers: your own calendars block time, others you only see, holidays ignored.
        const roles: Record<string, CalChoice> = {};
        for (const c of r.calendars) {
          roles[c.id] = d.calRoles[c.id] ?? (/holiday|birthday/i.test(c.name) || c.id.includes("#holiday") ? "ignore" : c.accessRole === "owner" ? "block" : "show");
        }
        set({ calRoles: roles });
      }
    } catch (e) {
      setCalError(e instanceof Error ? e.message : "Couldn’t reach Google");
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    void checkGoogle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const slots = useMemo(() => assignRoleSlots(d.roles), [d.roles]);
  const writable = (cals ?? []).filter((c) => c.accessRole === "owner" || c.accessRole === "writer");

  const steps: { title: string; body: () => ReactElement; ok?: () => string | null }[] = [
    {
      title: "Welcome",
      body: () => (
        <>
          <h1 className="text-xl font-semibold text-slate-100">Let’s build a week that fits your life</h1>
          <p className="text-sm text-slate-400 mt-1">A few questions about your calendars, roles and days. About 10 minutes, and you can change any answer later.</p>
          <label className={q}>What should we call you?</label>
          <input className={`${field} w-full`} placeholder="Your first name" value={d.name} onChange={(e) => set({ name: e.target.value })} />
          <label className={q}>Your time zone</label>
          <select className={field} value={d.tz} onChange={(e) => set({ tz: e.target.value })}>
            {ZONES.map(([z, l]) => (
              <option key={z} value={z}>
                {l} ({z})
              </option>
            ))}
            {!ZONES.some(([z]) => z === deviceZone) && <option value={deviceZone}>{zoneLabel(deviceZone)} ({deviceZone})</option>}
          </select>
          <p className={hint}>Everything is planned in this zone, even when your phone is somewhere else.</p>
          <label className={q}>Anything the goal coach should know about you? (optional)</label>
          <textarea
            className={`${field} w-full`}
            rows={2}
            placeholder="e.g. nurse on 12-hour shifts, two kids, best energy in the morning"
            value={d.about}
            onChange={(e) => set({ about: e.target.value })}
          />
          <p className={hint}>Your goal coach and morning briefing write with this in mind.</p>
        </>
      ),
      ok: () => (d.name.trim() ? null : "Add your name"),
    },
    {
      title: "Your calendars",
      body: () => (
        <>
          <h1 className="text-xl font-semibold text-slate-100">Connect your Google Calendar</h1>
          <p className="text-sm text-slate-400 mt-1">The app reads your calendars so it never plans over what’s already there, and puts your plan back on your phone.</p>
          {connected ? (
            <p className="mt-4 text-sm text-emerald-300">✓ Connected as {connected}</p>
          ) : (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                disabled={!isGoogleConfigured() || preview}
                onClick={() => {
                  const url = getOAuthUrl();
                  if (url) window.open(url, "_blank", "noopener,noreferrer");
                }}
                className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-900 disabled:opacity-50"
              >
                Sign in with Google
              </button>
              <button onClick={() => void checkGoogle()} className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300">
                {checking ? "Checking…" : "I’ve signed in — check"}
              </button>
              <p className={`${hint} w-full`}>Google opens in a new tab. If it says the app isn’t verified, tap Advanced → Go to the app. Come back here when it says connected.</p>
            </div>
          )}
          {calError && <p className="mt-2 text-xs text-rose-300">Couldn’t list your calendars: {calError}</p>}
          {connected && cals && (
            <>
              <label className={q}>What should each calendar do?</label>
              <div className="space-y-2">
                {cals.map((c) => (
                  <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/60 px-3 py-2">
                    <span className="flex-1 min-w-[140px] text-sm text-slate-100">
                      {c.name}
                      {c.primary && <span className="ml-1 text-[11px] text-slate-500">(main)</span>}
                    </span>
                    <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
                      {(
                        [
                          ["block", "Blocks my time"],
                          ["show", "Show only"],
                          ["ignore", "Ignore"],
                        ] as [CalChoice, string][]
                      ).map(([k, l]) => (
                        <button
                          key={k}
                          onClick={() => set({ calRoles: { ...d.calRoles, [c.id]: k } })}
                          className={`px-2.5 py-1 text-xs ${d.calRoles[c.id] === k ? "bg-blue-600 text-white" : "bg-slate-950 text-slate-400"}`}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <p className={hint}>“Show only” is for calendars like the kids’ school or your spouse’s schedule: you see them, but they don’t take your time. Events marked Free in Google never block.</p>
              <label className={q}>Where should your plan go?</label>
              <select className={field} value={d.planCal} onChange={(e) => set({ planCal: e.target.value })}>
                <option value={NEW_CAL}>A new calendar: “{NEW_CAL_NAME}” (recommended)</option>
                {writable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <p className={hint}>A separate calendar keeps the app’s blocks easy to hide or delete.</p>
            </>
          )}
        </>
      ),
      ok: () => (connected || preview ? null : "Connect Google first"),
    },
    {
      title: "Your roles",
      body: () => (
        <>
          <h1 className="text-xl font-semibold text-slate-100">What roles fill your life?</h1>
          <p className="text-sm text-slate-400 mt-1">Pick up to {MAX_ROLES}. Every task, habit and goal gets one, and your week shows how your time splits between them.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {[...new Set([...ROLE_IDEAS, ...d.roles])].map((r) => {
              const on = d.roles.includes(r);
              return (
                <button
                  key={r}
                  className={chip(on)}
                  disabled={!on && d.roles.length >= MAX_ROLES}
                  onClick={() => set({ roles: on ? d.roles.filter((x) => x !== r) : [...d.roles, r] })}
                >
                  {r}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex gap-2">
            <input className={`${field} flex-1`} placeholder="Add your own" value={newRole} onChange={(e) => setNewRole(e.target.value)} />
            <button
              className="flex items-center gap-1 rounded-lg bg-slate-700 px-3 text-sm text-white disabled:opacity-50"
              disabled={!newRole.trim() || d.roles.length >= MAX_ROLES || d.roles.includes(newRole.trim())}
              onClick={() => {
                set({ roles: [...d.roles, newRole.trim()] });
                setNewRole("");
              }}
            >
              <Plus className="h-4 w-4" /> Add
            </button>
          </div>
          <label className={q}>In the order you want them listed</label>
          <div className="space-y-1.5">
            {d.roles.map((r, i) => (
              <div key={r} className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5">
                <span className="w-5 text-xs text-slate-500">{i + 1}</span>
                <span className="flex-1 text-sm text-slate-100">{r}</span>
                <button disabled={i === 0} onClick={() => set({ roles: swap(d.roles, i, i - 1) })} className="p-1 text-slate-400 disabled:opacity-30" aria-label="Move up">
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button disabled={i === d.roles.length - 1} onClick={() => set({ roles: swap(d.roles, i, i + 1) })} className="p-1 text-slate-400 disabled:opacity-30" aria-label="Move down">
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </>
      ),
      ok: () => (d.roles.length ? null : "Pick at least one role"),
    },
    {
      title: "Your week",
      body: () => (
        <>
          <h1 className="text-xl font-semibold text-slate-100">What does a normal week look like?</h1>
          <p className="text-sm text-slate-400 mt-1">The fixed part of your week. If it’s already in Google Calendar, skip it — the app reads it from there.</p>
          <label className="mt-5 flex items-center gap-2 text-sm text-slate-200">
            <input type="checkbox" className="accent-blue-500" checked={d.works} onChange={(e) => set({ works: e.target.checked })} />I work set hours
          </label>
          {d.works && (
            <>
              <label className={q}>Days you work</label>
              <DayChips days={d.workDays} onChange={(days) => set({ workDays: days })} />
              <label className={q}>Usual hours</label>
              <div className="flex flex-wrap items-center gap-2">
                <input type="time" className={field} value={d.workFrom} onChange={(e) => set({ workFrom: e.target.value })} />
                <span className="text-sm text-slate-500">to</span>
                <input type="time" className={field} value={d.workTo} onChange={(e) => set({ workTo: e.target.value })} />
                <span className="ml-2 text-sm text-slate-400">Commute each way</span>
                <input type="number" min={0} max={180} className={`${field} w-20`} value={d.commute} onChange={(e) => set({ commute: Math.max(0, Number(e.target.value) || 0) })} />
                <span className="text-sm text-slate-500">min</span>
              </div>
              <p className={hint}>
                Saved as a repeating “Work” block from {fromMin(Math.max(0, toMin(d.workFrom) - d.commute))} to {fromMin(Math.min(24 * 60 - 1, toMin(d.workTo) + d.commute))}, commute included.
              </p>
            </>
          )}
          <label className={q}>Anything else that happens every week?</label>
          <div className="space-y-2">
            {d.blocks.map((b, i) => (
              <div key={i} className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
                <div className="flex gap-2">
                  <input className={`${field} flex-1`} placeholder="e.g. School drop-off" value={b.name} onChange={(e) => set({ blocks: patchAt(d.blocks, i, { name: e.target.value }) })} />
                  <button onClick={() => set({ blocks: d.blocks.filter((_, j) => j !== i) })} className="p-1.5 text-slate-500 hover:text-rose-300" aria-label="Remove">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-2">
                  <DayChips days={b.days} onChange={(days) => set({ blocks: patchAt(d.blocks, i, { days }) })} />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <input type="time" className={field} value={b.from} onChange={(e) => set({ blocks: patchAt(d.blocks, i, { from: e.target.value }) })} />
                  <span className="text-sm text-slate-500">to</span>
                  <input type="time" className={field} value={b.to} onChange={(e) => set({ blocks: patchAt(d.blocks, i, { to: e.target.value }) })} />
                </div>
              </div>
            ))}
            <button onClick={() => set({ blocks: [...d.blocks, { name: "", days: [1, 2, 3, 4, 5], from: "07:30", to: "08:00" }] })} className="flex items-center gap-1 text-sm text-blue-400">
              <Plus className="h-4 w-4" /> Add a weekly block
            </button>
          </div>
        </>
      ),
      ok: () => {
        if (d.works && (!d.workDays.length || toMin(d.workTo) <= toMin(d.workFrom))) return "Check your work days and hours";
        if (d.blocks.some((b) => !b.name.trim() || !b.days.length || toMin(b.to) <= toMin(b.from))) return "Each weekly block needs a name, days, and an end after its start";
        return null;
      },
    },
    {
      title: "Your days",
      body: () => (
        <>
          <h1 className="text-xl font-semibold text-slate-100">When can goal time happen?</h1>
          <p className="text-sm text-slate-400 mt-1">The weekly review suggests time for your goals only inside these windows.</p>
          {d.works && (
            <>
              <label className={q}>On work days</label>
              <Windows wins={d.workWindows} onChange={(w) => set({ workWindows: w })} />
            </>
          )}
          <label className={q}>{d.works ? "On days off" : "On a normal day"}</label>
          <Windows wins={d.offWindows} onChange={(w) => set({ offWindows: w })} />
          <label className={q}>Quiet hours</label>
          <div className="flex items-center gap-2">
            <select className={field} value={d.quietStart} onChange={(e) => set({ quietStart: Number(e.target.value) })}>
              {Array.from({ length: 5 }, (_, i) => 19 + i).map((h) => (
                <option key={h} value={h}>
                  {hourText(h % 24)}
                </option>
              ))}
            </select>
            <span className="text-sm text-slate-500">to</span>
            <select className={field} value={d.quietEnd} onChange={(e) => set({ quietEnd: Number(e.target.value) })}>
              {Array.from({ length: 6 }, (_, i) => 4 + i).map((h) => (
                <option key={h} value={h}>
                  {hourText(h)}
                </option>
              ))}
            </select>
          </div>
          <p className={hint}>Nothing is suggested or dropped in quiet hours unless you override it for one item.</p>
        </>
      ),
      ok: () => {
        const all = [...(d.works ? d.workWindows : []), ...d.offWindows];
        return all.some((w) => toMin(w.to) <= toMin(w.from)) ? "Each window needs an end after its start" : null;
      },
    },
    {
      title: "Features",
      body: () => (
        <>
          <h1 className="text-xl font-semibold text-slate-100">Pick what you want the app to do</h1>
          <p className="text-sm text-slate-400 mt-1">Leave anything you don’t need off. You can turn it on later.</p>
          <div className="mt-4 space-y-2">
            {(
              [
                ["briefing", "Morning briefing", "Your day, what’s first, and any heads-ups."],
                ["weeklyReview", "Weekly review", "Look back, then approve next week’s goal sessions."],
                ["trips", "Work travel (crew schedule)", "Drive time, get-ready time and hotel time around flights."],
                ["drill", "Military drill weekends", "Keeps family, home and errand items off drill days."],
                ["fitnessApp", "Running or fitness app", "Workouts from an app’s calendar (like Runna) count toward a goal."],
                ["bookingPage", "Booking page", "Keeps a page like Cal.com from offering time you need."],
              ] as [keyof AppFeatures, string, string][]
            ).map(([k, t, desc]) => (
              <label key={k} className="flex items-start gap-3 rounded-xl border border-slate-700 bg-slate-800/60 p-3">
                <input type="checkbox" className="mt-1 accent-blue-500" checked={d.features[k]} onChange={(e) => set({ features: { ...d.features, [k]: e.target.checked } })} />
                <span>
                  <span className="block text-sm font-medium text-slate-100">{t}</span>
                  <span className="block text-xs text-slate-400">{desc}</span>
                </span>
              </label>
            ))}
          </div>
        </>
      ),
    },
    {
      title: "Your goals",
      body: () => (
        <>
          <h1 className="text-xl font-semibold text-slate-100">What do you want to work on?</h1>
          <p className="text-sm text-slate-400 mt-1">Start with one or two, roughly. The Goals tab helps you shape each one into a plan after setup.</p>
          <div className="mt-4 space-y-2">
            {d.goals.map((g, i) => (
              <div key={i} className="rounded-xl border border-slate-700 bg-slate-800/60 p-3">
                <div className="flex gap-2">
                  <input className={`${field} flex-1`} placeholder="e.g. Walk 3 times a week" value={g.text} onChange={(e) => set({ goals: patchAt(d.goals, i, { text: e.target.value }) })} />
                  <button onClick={() => set({ goals: d.goals.filter((_, j) => j !== i) })} className="p-1.5 text-slate-500 hover:text-rose-300" aria-label="Remove goal">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <select className={`${field} mt-2`} value={d.roles.includes(g.role) ? g.role : d.roles[0]} onChange={(e) => set({ goals: patchAt(d.goals, i, { role: e.target.value }) })}>
                  {d.roles.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </div>
            ))}
            {d.goals.length < 3 && (
              <button onClick={() => set({ goals: [...d.goals, { text: "", role: d.roles[0] }] })} className="flex items-center gap-1 text-sm text-blue-400">
                <Plus className="h-4 w-4" /> Add a goal
              </button>
            )}
          </div>
        </>
      ),
    },
    {
      title: "Review",
      body: () => (
        <>
          <h1 className="text-xl font-semibold text-slate-100">Here’s your setup{d.name.trim() ? `, ${d.name.trim()}` : ""}</h1>
          <p className="text-sm text-slate-400 mt-1">{preview ? "This is a preview — nothing is saved." : "Check it over. Nothing is written until you tap Build my week."}</p>
          <dl className="mt-4 space-y-3 text-sm">
            <Row k="Time zone" v={`${zoneLabel(d.tz)} (${d.tz})`} />
            <Row k="Calendars that block your time" v={(cals ?? []).filter((c) => d.calRoles[c.id] === "block").map((c) => c.name).join(", ") || "—"} />
            <Row k="Your plan goes to" v={d.planCal === NEW_CAL ? `A new calendar, “${NEW_CAL_NAME}”` : (cals ?? []).find((c) => c.id === d.planCal)?.name ?? "—"} />
            <Row k="Roles" v={d.roles.join(" · ")} />
            <Row
              k="Work"
              v={d.works ? `${DAY_ORDER.filter((x) => d.workDays.includes(x)).map((x) => DOW[x]).join(" ")} · ${d.workFrom}–${d.workTo} · ${d.commute} min commute` : "No set hours"}
            />
            {d.blocks.length > 0 && <Row k="Weekly blocks" v={d.blocks.map((b) => `${b.name} (${b.from}–${b.to})`).join(", ")} />}
            <Row
              k="Goal time"
              v={`${d.works ? `Work days ${d.workWindows.map((w) => `${w.from}–${w.to}`).join(", ") || "none"} · days off ` : ""}${d.offWindows.map((w) => `${w.from}–${w.to}`).join(", ") || "none"}`}
            />
            <Row k="Quiet hours" v={`${hourText(d.quietStart % 24)}–${hourText(d.quietEnd)}`} />
            <Row
              k="Turned on"
              v={
                (
                  [
                    ["briefing", "Morning briefing"],
                    ["weeklyReview", "Weekly review"],
                    ["trips", "Work travel"],
                    ["drill", "Drill weekends"],
                    ["fitnessApp", "Fitness app"],
                    ["bookingPage", "Booking page"],
                  ] as [keyof AppFeatures, string][]
                )
                  .filter(([k]) => d.features[k])
                  .map(([, l]) => l)
                  .join(", ") || "—"
              }
            />
            <Row k="First goals" v={d.goals.filter((g) => g.text.trim()).map((g) => g.text.trim()).join("; ") || "None yet"} />
          </dl>
          {buildError && <p className="mt-3 text-sm text-rose-300">{buildError}</p>}
          {previewDone && <p className="mt-3 text-sm text-emerald-300">Preview finished — nothing was saved. Close to go back to your calendar.</p>}
        </>
      ),
    },
  ];

  const step = steps[d.step];
  const problem = step.ok?.() ?? null;
  const last = d.step === steps.length - 1;

  async function build() {
    if (preview) {
      setPreviewDone(true);
      return;
    }
    setBuilding(true);
    setBuildError(null);
    try {
      await buildMyWeek(d, cals ?? [], slots);
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        /* nothing to clear */
      }
      // Settings go last: saving them reloads the app into its normal screens.
      window.history.replaceState({}, "", d.features.weeklyReview ? "/?view=review" : "/");
      await saveAppSettings({
        setupDone: true,
        displayName: d.name.trim(),
        aboutMe: d.about.trim(),
        homeTimeZone: d.tz,
        homeTimeLabel: zoneLabel(d.tz),
        quietStartHour: d.quietStart % 24,
        quietEndHour: d.quietEnd,
        roleLabels: slots.labels,
        roleOrder: slots.order,
        features: d.features,
      });
      window.location.reload();
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : "Something went wrong. Your answers are kept; try again.");
      setBuilding(false);
    }
  }

  return (
    <div className="min-h-[100dvh] bg-slate-950 px-4 py-6 text-slate-100">
      <div className="mx-auto max-w-xl">
        {preview && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <span className="flex-1">Preview of first-time setup — nothing you enter here is saved.</span>
            <button onClick={onClose} className="font-semibold">
              Close
            </button>
          </div>
        )}
        <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5 sm:p-6">
          <div className="mb-4 flex gap-1">
            {steps.map((_, i) => (
              <span key={i} className={`h-1 flex-1 rounded-full ${i <= d.step ? "bg-blue-500" : "bg-slate-800"}`} />
            ))}
          </div>
          <p className="mb-1 text-xs text-slate-500">
            Step {d.step + 1} of {steps.length} · {step.title}
          </p>
          {step.body()}
          {problem && <p className="mt-4 text-xs text-amber-300">{problem}</p>}
          <div className="mt-6 flex items-center justify-between">
            <button
              onClick={() => set({ step: d.step - 1 })}
              className={`rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 ${d.step === 0 ? "invisible" : ""}`}
            >
              Back
            </button>
            {last ? (
              <button
                onClick={() => (previewDone ? onClose() : void build())}
                disabled={building}
                className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {building ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {previewDone ? "Close" : building ? "Building…" : "Build my week"}
              </button>
            ) : (
              <button onClick={() => set({ step: d.step + 1 })} disabled={!!problem} className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{k}</dt>
      <dd className="text-slate-200">{v}</dd>
    </div>
  );
}

function DayChips({ days, onChange }: { days: number[]; onChange: (d: number[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {DAY_ORDER.map((x) => (
        <button key={x} className={chip(days.includes(x))} onClick={() => onChange(days.includes(x) ? days.filter((y) => y !== x) : [...days, x].sort())}>
          {DOW[x]}
        </button>
      ))}
    </div>
  );
}

function Windows({ wins, onChange }: { wins: Win[]; onChange: (w: Win[]) => void }) {
  return (
    <div className="space-y-1.5">
      {wins.length === 0 && <p className="text-xs text-amber-300/90">No goal time on these days.</p>}
      {wins.map((w, i) => (
        <div key={i} className="flex items-center gap-2">
          <input type="time" step={900} className={field} value={w.from} onChange={(e) => onChange(patchAt(wins, i, { from: e.target.value }))} />
          <span className="text-sm text-slate-500">to</span>
          <input type="time" step={900} className={field} value={w.to} onChange={(e) => onChange(patchAt(wins, i, { to: e.target.value }))} />
          <button onClick={() => onChange(wins.filter((_, j) => j !== i))} className="p-1 text-slate-500 hover:text-rose-300" aria-label="Remove these times">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button onClick={() => onChange([...wins, { from: "09:00", to: "11:00" }])} className="text-xs text-blue-400">
        + Add times
      </button>
    </div>
  );
}

function swap<T>(a: T[], i: number, j: number): T[] {
  const b = [...a];
  [b[i], b[j]] = [b[j], b[i]];
  return b;
}
function patchAt<T>(a: T[], i: number, p: Partial<T>): T[] {
  return a.map((x, j) => (j === i ? { ...x, ...p } : x));
}

/** First date on/after today that falls on one of these weekdays, at hh:mm (home time). */
function firstOccurrence(days: number[], hhmm: string): Date {
  const now = new Date();
  for (let k = 0; k < 7; k++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k);
    if (days.includes(day.getDay())) {
      const [h, m] = hhmm.split(":").map(Number);
      return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
    }
  }
  return now;
}

/**
 * Writes the answers: calendars, repeating blocks, day routines and goals.
 * (Settings are saved by the caller afterwards, since that reloads the app.)
 */
async function buildMyWeek(d: Draft, cals: GoogleCalendarInfo[], slots: { labels: Record<string, string>; order: LifePillar[] }) {
  // 1. Calendars: replace whatever placeholder rows a new copy starts with.
  if (cals.length) {
    let planId = d.planCal;
    let planName = cals.find((c) => c.id === planId)?.name ?? NEW_CAL_NAME;
    if (planId === NEW_CAL) {
      const made = await createGoogleCalendar(NEW_CAL_NAME, d.tz);
      planId = made.id;
      planName = made.name;
    }
    const rows = cals
      .filter((c) => (d.calRoles[c.id] ?? "ignore") !== "ignore" && c.id !== planId)
      .map((c) => ({ name: c.name, calendar_id: c.id, role: d.calRoles[c.id] === "block" ? "fixed_source" : "display_only", enabled: true }));
    rows.push({ name: planName, calendar_id: planId, role: "schedule_target", enabled: true });
    const { error: delErr } = await supabase.from("calendar_connections").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (delErr) throw new Error(`Couldn’t clear the old calendar settings: ${delErr.message}`);
    const { error } = await supabase.from("calendar_connections").insert(rows);
    if (error) throw new Error(`Couldn’t save your calendars: ${error.message}`);
  }

  // 2. Repeating blocks: work (commute included) and anything else weekly.
  const roleKeyFor = (re: RegExp) => (Object.entries(slots.labels).find(([, n]) => re.test(n))?.[0] ?? null) as LifePillar | null;
  const weekly: { name: string; days: number[]; from: string; to: string; pillar: LifePillar | null }[] = [];
  if (d.works && d.workDays.length) {
    weekly.push({
      name: "Work",
      days: d.workDays,
      from: fromMin(Math.max(0, toMin(d.workFrom) - d.commute)),
      to: fromMin(Math.min(24 * 60 - 1, toMin(d.workTo) + d.commute)),
      pillar: roleKeyFor(/work|career|job/i),
    });
  }
  for (const b of d.blocks) weekly.push({ ...b, name: b.name.trim(), pillar: null });
  if (weekly.length) {
    const rows = weekly.map((w) => {
      const start = firstOccurrence(w.days, w.from);
      const end = new Date(start.getTime() + (toMin(w.to) - toMin(w.from)) * 60000);
      return {
        name: w.name,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        is_all_day: false,
        pillar: w.pillar,
        recurrence_enabled: true,
        recurrence_frequency: "weekly",
        recurrence_interval: 1,
        recurrence_weekdays: w.days,
        recurrence_end_mode: "never",
      };
    });
    const { error } = await supabase.from("fixed_events").insert(rows);
    if (error) throw new Error(`Couldn’t save your weekly blocks: ${error.message}`);
  }

  // 3. Day routines: the starter ones for switched-on features, plus work day / normal day.
  const existing = await loadDayRoutines();
  for (const r of existing) if (r.id) await deleteDayRoutine(r);
  const win = (ws: Win[]): RoutineWindow[] => ws.filter((w) => toMin(w.to) > toMin(w.from)).map((w) => ({ from: w.from, to: w.to }));
  const routines: DayRoutine[] = STARTER_ROUTINES.filter((r) => (r.key === "uta" && d.features.drill) || ((r.key === "flying" || r.key === "reserve") && d.features.trips));
  // A day counts as a work day when it has the Work block (8+ hours, commute included) or an all-day "work" event.
  if (d.works) routines.push({ key: "work_day", label: "Work day", kind: "keywords", keywords: "work", windows: win(d.workWindows), enabled: true, position: 50 });
  routines.push({ key: "normal", label: d.works ? "Day off" : "Normal day", kind: "default", keywords: "", windows: win(d.offWindows), enabled: true, position: 100 });
  for (const r of routines) await saveDayRoutine(r);

  // 4. First goals: saved as drafts and handed to the goal coach, like "New goal" on the Goals tab.
  for (const g of d.goals.filter((x) => x.text.trim())) {
    const pillar = (Object.entries(slots.labels).find(([, n]) => n === g.role)?.[0] ?? slots.order[0]) as LifePillar;
    const { data, error } = await supabase.from("goals").insert({ pillar, status: "draft" }).select("id").single();
    if (error || !data) continue;
    try {
      await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/smart-gate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "chat", goal_id: (data as { id: string }).id, message: g.text.trim() }),
      });
    } catch {
      /* the draft is there; the coach can pick it up on the Goals tab */
    }
  }
}
