import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Loader2, X } from "lucide-react";
import { appSettings, ORIGINAL_ABOUT, type AppFeatures } from "@/lib/appSettings";
import { saveAppSettings } from "@/lib/appSettingsLoader";
import { PILLAR_LABELS, PILLARS, type LifePillar } from "@/lib/types";
import { APP_VERSION, SCHEMA_VERSION, databaseVersion } from "@/lib/version";
import { getSyncStatus } from "@/lib/gcalSync";
import { CalendarConnectionsPanel } from "./CalendarConnectionsPanel";
import { DayRoutinesEditor } from "./DayRoutinesEditor";

/**
 * Settings: the same answers as first-time setup, changeable any time — who you
 * are, time zone, quiet hours, your roles, and which features are on. Calendars
 * and day routines open their own editors. The bottom shows which version of
 * the app and database this copy is running, so two copies can be compared.
 */

const ALL_ROLES: LifePillar[] = ["spiritual", "family", "physical", "civ_career", "mil_career", "mental", "financial"];
const BUILT_IN: Record<LifePillar, string> = {
  spiritual: "Spiritual",
  family: "Family",
  mil_career: "Mil Career",
  civ_career: "Civ Career",
  financial: "Financial",
  physical: "Physical",
  mental: "Mental",
};
const ZONES: [string, string][] = [
  ["America/New_York", "Eastern time"],
  ["America/Chicago", "Central time"],
  ["America/Denver", "Mountain time"],
  ["America/Phoenix", "Arizona time"],
  ["America/Los_Angeles", "Pacific time"],
  ["America/Anchorage", "Alaska time"],
  ["Pacific/Honolulu", "Hawaii time"],
];
const FEATURES: [keyof AppFeatures, string, string][] = [
  ["briefing", "Morning briefing", "The Today / Briefing tab."],
  ["weeklyReview", "Weekly review", "The Review tab: look back and approve next week’s goal sessions."],
  ["trips", "Work travel (crew schedule)", "Drive time, get-ready, report and hotel time around flights; Flying and Reserve days."],
  ["drill", "Military drill weekends", "Keeps family, desk, home and errand items off UTA days."],
  ["fitnessApp", "Running or fitness app", "Workouts from an app’s calendar (like Runna) count toward goals."],
  ["bookingPage", "Booking page", "Keeps get-ready and hotel time busy in Google for a page like Cal.com."],
];
const field = "rounded-lg bg-slate-950 border border-slate-700 px-2.5 py-1.5 text-sm text-slate-100";
const h = (n: number) => `${String(n % 24).padStart(2, "0")}:00`;

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState(appSettings.displayName);
  const [about, setAbout] = useState(appSettings.aboutMe ?? ORIGINAL_ABOUT);
  const [tz, setTz] = useState(appSettings.homeTimeZone);
  const [tzLabel, setTzLabel] = useState(appSettings.homeTimeLabel);
  const [quietStart, setQuietStart] = useState(appSettings.quietStartHour);
  const [quietEnd, setQuietEnd] = useState(appSettings.quietEndHour);
  const [roles, setRoles] = useState<{ key: LifePillar; label: string; on: boolean }[]>(() => {
    const shown = [...PILLARS];
    return [...shown, ...ALL_ROLES.filter((k) => !shown.includes(k))].map((k) => ({ key: k, label: PILLAR_LABELS[k] ?? BUILT_IN[k], on: shown.includes(k) }));
  });
  const [features, setFeatures] = useState<AppFeatures>({ ...appSettings.features });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [sub, setSub] = useState<"calendars" | "routines" | null>(null);
  const [dbVersion, setDbVersion] = useState<number | null>(null);
  const [syncVersion, setSyncVersion] = useState<string | null>(null);

  useEffect(() => {
    void databaseVersion().then(setDbVersion);
    void getSyncStatus()
      .then((s) => setSyncVersion(((s as unknown as { functionVersion?: string }) ?? {}).functionVersion ?? "unknown"))
      .catch(() => setSyncVersion("unreachable"));
  }, []);

  const move = (i: number, d: number) =>
    setRoles((rs) => {
      const b = [...rs];
      [b[i], b[i + d]] = [b[i + d], b[i]];
      return b;
    });

  async function save() {
    const shown = roles.filter((r) => r.on);
    if (!shown.length) return setError("Keep at least one role.");
    if (roles.some((r) => r.on && !r.label.trim())) return setError("Every role you keep needs a name.");
    setSaving(true);
    setError(null);
    try {
      const labels = Object.fromEntries(roles.filter((r) => r.label.trim() && r.label.trim() !== BUILT_IN[r.key]).map((r) => [r.key, r.label.trim()]));
      const order = shown.map((r) => r.key);
      await saveAppSettings({
        displayName: name.trim(),
        aboutMe: about.trim(),
        homeTimeZone: tz,
        homeTimeLabel: tzLabel.trim() || (ZONES.find(([z]) => z === tz)?.[1] ?? tz),
        quietStartHour: quietStart % 24,
        quietEndHour: quietEnd,
        roleLabels: labels,
        // All seven in built-in order is the same as "no choice made".
        roleOrder: order.length === ALL_ROLES.length && order.every((k, i) => k === PILLARS_BUILT_IN[i]) ? [] : order,
        features,
      });
      setSaved(true); // a change to time zone or quiet hours reloads the app instead
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t save");
    } finally {
      setSaving(false);
    }
  }

  if (sub === "calendars") return <CalendarConnectionsPanel onClose={() => setSub(null)} />;
  if (sub === "routines") return <DayRoutinesEditor onClose={() => setSub(null)} />;

  const dbBehind = dbVersion !== null && dbVersion < SCHEMA_VERSION;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 sm:p-4" onClick={onClose}>
      <div
        className="w-full sm:max-w-xl max-h-[90dvh] overflow-y-auto rounded-t-3xl sm:rounded-2xl border border-slate-700 bg-slate-900 p-5 pb-[calc(20px+env(safe-area-inset-bottom))] sm:pb-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-slate-100">Settings</h2>
          <button onClick={onClose} className="ml-auto p-1.5 rounded-lg hover:bg-slate-800" aria-label="Close">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        <Section title="About you">
          <input className={`${field} w-full`} placeholder="Your first name" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea
            className={`${field} mt-2 w-full`}
            rows={2}
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            placeholder="A sentence about you for the goal coach and briefing (e.g. nurse on 12-hour shifts, two kids)"
          />
          <p className="text-xs text-slate-500 mt-1">The goal coach and the briefing write with this in mind.</p>
        </Section>

        <Section title="Time">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={field}
              value={tz}
              onChange={(e) => {
                setTz(e.target.value);
                setTzLabel(ZONES.find(([z]) => z === e.target.value)?.[1] ?? tzLabel);
              }}
            >
              {[...ZONES, ...(ZONES.some(([z]) => z === tz) ? [] : [[tz, tz] as [string, string]])].map(([z, l]) => (
                <option key={z} value={z}>
                  {l} ({z})
                </option>
              ))}
            </select>
            <input className={`${field} w-36`} value={tzLabel} onChange={(e) => setTzLabel(e.target.value)} aria-label="What to call it" />
          </div>
          <div className="mt-2 flex items-center gap-2 text-sm text-slate-300">
            Quiet hours
            <select className={field} value={quietStart} onChange={(e) => setQuietStart(Number(e.target.value))}>
              {[19, 20, 21, 22, 23].map((x) => (
                <option key={x} value={x}>
                  {h(x)}
                </option>
              ))}
            </select>
            to
            <select className={field} value={quietEnd} onChange={(e) => setQuietEnd(Number(e.target.value))}>
              {[4, 5, 6, 7, 8, 9, 10].map((x) => (
                <option key={x} value={x}>
                  {h(x)}
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-slate-500 mt-1">Changing these reloads the app.</p>
        </Section>

        <Section title="Roles">
          <div className="space-y-1.5">
            {roles.map((r, i) => (
              <div key={r.key} className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${r.on ? "border-slate-700 bg-slate-800/60" : "border-slate-800 opacity-60"}`}>
                <input
                  type="checkbox"
                  className="accent-blue-500"
                  checked={r.on}
                  onChange={() => setRoles((rs) => rs.map((x) => (x.key === r.key ? { ...x, on: !x.on } : x)))}
                  aria-label={`Use ${r.label}`}
                />
                <input
                  className="flex-1 min-w-0 bg-transparent text-sm text-slate-100 outline-none focus:underline"
                  value={r.label}
                  onChange={(e) => setRoles((rs) => rs.map((x) => (x.key === r.key ? { ...x, label: e.target.value } : x)))}
                />
                <button disabled={i === 0} onClick={() => move(i, -1)} className="p-1 text-slate-400 disabled:opacity-30" aria-label="Move up">
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button disabled={i === roles.length - 1} onClick={() => move(i, 1)} className="p-1 text-slate-400 disabled:opacity-30" aria-label="Move down">
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-1">Unticked roles disappear from pickers; items already using them keep it.</p>
        </Section>

        <Section title="Features">
          <div className="space-y-1.5">
            {FEATURES.map(([k, t, d]) => (
              <label key={k} className="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/60 p-2.5">
                <input type="checkbox" className="mt-1 accent-blue-500" checked={features[k]} onChange={(e) => setFeatures({ ...features, [k]: e.target.checked })} />
                <span>
                  <span className="block text-sm text-slate-100">{t}</span>
                  <span className="block text-xs text-slate-400">{d}</span>
                </span>
              </label>
            ))}
          </div>
        </Section>

        <Section title="Calendars and days">
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setSub("calendars")} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
              Google calendars…
            </button>
            <button onClick={() => setSub("routines")} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
              Day routines…
            </button>
          </div>
        </Section>

        {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
        {saved && <p className="mt-3 text-sm text-emerald-300">Saved.</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300">
            Close
          </button>
          <button onClick={() => void save()} disabled={saving} className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </button>
        </div>

        <div className="mt-5 border-t border-slate-800 pt-3 text-[11px] text-slate-500 space-y-0.5">
          <div>App version {APP_VERSION}</div>
          <div className={dbBehind ? "text-amber-300" : ""}>
            Database version {dbVersion === null ? "…" : dbVersion || "not set"} (this app needs {SCHEMA_VERSION}){dbBehind ? " — needs an update" : " ✓"}
          </div>
          <div>Google sync {syncVersion ?? "…"}</div>
        </div>
      </div>
    </div>
  );
}

const PILLARS_BUILT_IN: LifePillar[] = ["spiritual", "family", "mil_career", "civ_career", "financial", "physical", "mental"];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h3>
      {children}
    </section>
  );
}
