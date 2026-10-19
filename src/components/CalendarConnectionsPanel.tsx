import { useCallback, useEffect, useMemo, useState } from "react";
import { Calendar, Check, ChevronDown, ChevronRight, ExternalLink, Loader2, Plus, RefreshCw, Settings, Trash2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { CalendarConnection, CalendarRole } from "@/lib/types";
import {
  createGoogleCalendar,
  disconnectGoogle,
  getOAuthUrl,
  getSyncStatus,
  isGoogleConfigured,
  listGoogleCalendars,
  type GoogleCalendarInfo,
} from "@/lib/gcalSync";
import { mirrorCalendarNames } from "@/lib/googleMirror";
import { getStravaOAuthUrl, stravaDisconnect, stravaStatus, stravaSync, type StravaStatus } from "@/lib/gcalSync";
import { appSettings } from "@/lib/appSettings";

/** Fired when calendar choices change, so the calendar can sync with the new setup. */
export const CALENDARS_CHANGED_EVENT = "calendar-connections-changed";

/**
 * What the app does with one Google calendar. Stored as one row per role in
 * calendar_connections, so "write + block" is a Write target row plus a
 * Blocking source row for the same calendar (the sync never reads back its own
 * planned events, so the two don't collide).
 */
type CalUse = "off" | "block" | "show" | "write" | "write_block";

const USES: { value: CalUse; label: string; hint: string; writes: boolean }[] = [
  { value: "off", label: "Don't use", hint: "The app ignores this calendar.", writes: false },
  { value: "block", label: "Block my time", hint: "Its events come in and the plan works around them.", writes: false },
  { value: "show", label: "Show only", hint: "Its events come in for reference but don't block time.", writes: false },
  { value: "write", label: "Write the plan here", hint: "The app puts your planned tasks and habits on this calendar.", writes: true },
  {
    value: "write_block",
    label: "Write the plan here + block my time",
    hint: "The plan goes here, and anything else you add to this calendar blocks time.",
    writes: true,
  },
];

const ROLES_FOR: Record<CalUse, CalendarRole[]> = {
  off: [],
  block: ["fixed_source"],
  show: ["display_only"],
  write: ["schedule_target"],
  write_block: ["schedule_target", "fixed_source"],
};

const SOURCE_ROLES: CalendarRole[] = ["fixed_source", "display_only"];

function usageOf(rows: CalendarConnection[]): CalUse {
  const on = rows.filter((r) => r.enabled);
  const target = on.some((r) => r.role === "schedule_target");
  const block = on.some((r) => r.role === "fixed_source");
  const show = on.some((r) => r.role === "display_only");
  if (target && block) return "write_block";
  if (target) return "write";
  if (block) return "block";
  if (show) return "show";
  return "off";
}

const canWrite = (c: GoogleCalendarInfo) => c.accessRole === "owner" || c.accessRole === "writer";

function accessLabel(c: GoogleCalendarInfo): string {
  if (c.primary) return "Your main calendar";
  if (c.accessRole === "owner") return "Yours";
  if (c.accessRole === "writer") return "Can edit";
  if (c.accessRole === "freeBusyReader") return "Free/busy only";
  return "View only";
}

const DEFAULT_NEW_NAME = "Smart Scheduler";

export function CalendarConnectionsPanel({ onClose }: { onClose: () => void }) {
  const [connections, setConnections] = useState<CalendarConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null);
  const [statusChecked, setStatusChecked] = useState(false);
  const [googleCals, setGoogleCals] = useState<GoogleCalendarInfo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [busyCal, setBusyCal] = useState<string | null>(null);
  const [newName, setNewName] = useState(DEFAULT_NEW_NAME);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [changed, setChanged] = useState(false);

  const loadConnections = useCallback(async () => {
    const { data, error } = await supabase.from("calendar_connections").select("*").order("created_at");
    if (error) setMessage("Could not load calendar settings.");
    else setConnections((data as CalendarConnection[]) ?? []);
    setLoading(false);
  }, []);

  const fetchCalendars = useCallback(async () => {
    setFetching(true);
    setListError(null);
    const r = await listGoogleCalendars();
    setFetching(false);
    if (r.error) {
      setListError(r.error);
      setGoogleCals(null);
      return;
    }
    // Your own calendars first, then ones you can edit, then view-only.
    const rank = (c: GoogleCalendarInfo) => (c.primary ? 0 : c.accessRole === "owner" ? 1 : c.accessRole === "writer" ? 2 : 3);
    setGoogleCals([...r.calendars].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)));
  }, []);

  const loadStatus = useCallback(async () => {
    const status = await getSyncStatus();
    const email = status?.connected ? status.email ?? "your Google account" : null;
    setConnectedEmail(email);
    setStatusChecked(true);
    return !!email;
  }, []);

  useEffect(() => {
    void loadConnections();
    void loadStatus().then((ok) => {
      if (ok) void fetchCalendars();
    });
  }, [loadConnections, loadStatus, fetchCalendars]);

  // Coming back from Google's sign-in tab: pick up the new connection and its calendars.
  useEffect(() => {
    const onFocus = () => {
      void loadStatus().then((ok) => {
        if (ok) void fetchCalendars();
      });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadStatus, fetchCalendars]);

  function close() {
    if (changed) window.dispatchEvent(new Event(CALENDARS_CHANGED_EVENT));
    onClose();
  }

  function connectGoogle() {
    const url = getOAuthUrl();
    if (!url) {
      setMessage("Google sign-in isn't set up for this copy of the app yet.");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function disconnect() {
    const result = await disconnectGoogle();
    setMessage(result.success ? "Google account disconnected." : "Could not disconnect Google.");
    setConnectedEmail(null);
    setGoogleCals(null);
  }

  /** Removes the app's copies of events pulled from a calendar it no longer reads. */
  async function forgetPulledEvents(calendarId: string) {
    const { data: maps } = await supabase
      .from("gcal_event_map")
      .select("id, item_id")
      .eq("calendar_id", calendarId)
      .eq("item_type", "fixed_event")
      .in("calendar_role", SOURCE_ROLES);
    const itemIds = (maps ?? []).map((m) => m.item_id as string | null).filter((x): x is string => !!x);
    for (let i = 0; i < itemIds.length; i += 100) {
      await supabase.from("fixed_events").delete().in("id", itemIds.slice(i, i + 100));
    }
    const mapIds = (maps ?? []).map((m) => m.id as string);
    for (let i = 0; i < mapIds.length; i += 100) {
      await supabase.from("gcal_event_map").delete().in("id", mapIds.slice(i, i + 100));
    }
  }

  /** Makes the saved rows for one calendar match the chosen use. */
  async function applyUse(calendarId: string, name: string, use: CalUse) {
    setBusyCal(calendarId);
    setMessage(null);
    try {
      const rows = connections.filter((c) => c.calendar_id === calendarId);
      const want = ROLES_FOR[use];
      const wantSource = want.find((r) => SOURCE_ROLES.includes(r));
      const wantTarget = want.includes("schedule_target");
      const now = new Date().toISOString();
      const errors: string[] = [];
      const run = async (q: PromiseLike<{ error: { message: string } | null }>) => {
        const { error } = await q;
        if (error) errors.push(error.message);
      };

      // Source side (block / show): reuse one row, change its role if needed.
      const sourceRows = rows.filter((r) => SOURCE_ROLES.includes(r.role));
      const hadSource = sourceRows.some((r) => r.enabled);
      if (wantSource) {
        const [keep, ...extra] = sourceRows;
        if (keep) await run(supabase.from("calendar_connections").update({ role: wantSource, enabled: true, name, updated_at: now }).eq("id", keep.id));
        else await run(supabase.from("calendar_connections").insert({ name, calendar_id: calendarId, role: wantSource, enabled: true }));
        for (const r of extra) await run(supabase.from("calendar_connections").delete().eq("id", r.id));
      } else {
        for (const r of sourceRows) await run(supabase.from("calendar_connections").delete().eq("id", r.id));
      }

      // Write side.
      const targetRows = rows.filter((r) => r.role === "schedule_target");
      if (wantTarget) {
        const [keep, ...extra] = targetRows;
        if (keep) await run(supabase.from("calendar_connections").update({ enabled: true, name, updated_at: now }).eq("id", keep.id));
        else await run(supabase.from("calendar_connections").insert({ name, calendar_id: calendarId, role: "schedule_target", enabled: true }));
        for (const r of extra) await run(supabase.from("calendar_connections").delete().eq("id", r.id));
      } else {
        for (const r of targetRows) await run(supabase.from("calendar_connections").delete().eq("id", r.id));
      }

      // No longer read at all: its events shouldn't keep blocking time.
      if (hadSource && !wantSource) await forgetPulledEvents(calendarId);

      await loadConnections();
      setChanged(true);
      setMessage(errors.length ? `Couldn't save everything: ${errors[0]}` : `${name}: ${USES.find((u) => u.value === use)!.label}.`);
    } finally {
      setBusyCal(null);
    }
  }

  async function createCalendar() {
    const name = newName.trim() || DEFAULT_NEW_NAME;
    setCreating(true);
    setMessage(null);
    try {
      const made = await createGoogleCalendar(name, appSettings.homeTimeZone);
      const { error } = await supabase
        .from("calendar_connections")
        .insert({ name: made.name, calendar_id: made.id, role: "schedule_target", enabled: true });
      if (error) throw new Error(error.message);
      await Promise.all([loadConnections(), fetchCalendars()]);
      setChanged(true);
      setShowCreate(false);
      setMessage(`Created "${made.name}" in Google Calendar. The plan will be written there.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not create the calendar.");
    } finally {
      setCreating(false);
    }
  }

  // Rows that aren't one of the fetched Google calendars: added by ID, or old empty placeholders.
  const googleIds = useMemo(() => new Set((googleCals ?? []).map((c) => c.id)), [googleCals]);
  const manualRows = useMemo(() => connections.filter((c) => !googleIds.has(c.calendar_id)), [connections, googleIds]);
  const writeTo = mirrorCalendarNames(connections);
  const nameTaken = (googleCals ?? []).some((c) => c.name.toLowerCase() === newName.trim().toLowerCase());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={close}>
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/15 text-blue-400">
              <Settings className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-semibold">Google calendars</h2>
              <p className="text-xs text-slate-400">Choose what the app does with each of your calendars</p>
            </div>
          </div>
          <button onClick={close} className="rounded-lg p-2 hover:bg-slate-800" aria-label="Close">
            <X className="h-5 w-5 text-slate-400" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          {/* Connection */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 p-4">
            <div className="text-sm text-blue-100">
              <div className="font-medium">{connectedEmail ? `Connected as ${connectedEmail}` : "Connect Google Calendar"}</div>
              <div className="mt-1 text-xs text-blue-200/70">
                {connectedEmail
                  ? "Your calendars are listed below."
                  : "Sign in once. On Google's screen, tick the box that lets the app see and edit your calendars."}
              </div>
            </div>
            {connectedEmail ? (
              <div className="flex gap-2">
                <button
                  onClick={connectGoogle}
                  disabled={!isGoogleConfigured()}
                  className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Reconnect
                </button>
                <button
                  onClick={() => void disconnect()}
                  className="rounded-lg border border-blue-300/30 px-3 py-2 text-xs font-medium text-blue-100 hover:bg-blue-500/20"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={connectGoogle}
                disabled={!isGoogleConfigured()}
                className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Connect Google
              </button>
            )}
          </div>
          {!isGoogleConfigured() && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              Google sign-in is waiting for this copy's Google client ID.
            </div>
          )}

          {/* Calendars from Google */}
          {connectedEmail && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-slate-200">Your calendars</div>
                <button
                  onClick={() => void fetchCalendars()}
                  disabled={fetching}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${fetching ? "animate-spin" : ""}`} /> {fetching ? "Fetching…" : "Fetch calendars"}
                </button>
              </div>

              {listError && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
                  <div>{listError}</div>
                  <button onClick={connectGoogle} className="mt-2 rounded-md bg-amber-500/20 px-2.5 py-1 font-medium hover:bg-amber-500/30">
                    Reconnect Google
                  </button>
                </div>
              )}

              {googleCals === null && !listError && (
                <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Getting your calendars from Google…
                </div>
              )}

              {googleCals?.length === 0 && <div className="py-4 text-sm text-slate-500">Google didn't return any calendars.</div>}

              {googleCals?.map((cal) => {
                const rows = connections.filter((c) => c.calendar_id === cal.id);
                const use = usageOf(rows);
                const writable = canWrite(cal);
                const info = USES.find((u) => u.value === use)!;
                const lastSynced = rows.map((r) => r.last_synced_at).filter(Boolean).sort().pop();
                return (
                  <div
                    key={cal.id}
                    className={`rounded-xl border p-3.5 ${use === "off" ? "border-slate-800 bg-slate-950/30" : "border-slate-700 bg-slate-950/60"}`}
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: cal.color ?? "#64748b" }} />
                      <div className="min-w-[8rem] flex-1">
                        <div className={`truncate text-sm font-medium ${use === "off" ? "text-slate-400" : "text-slate-100"}`}>{cal.name}</div>
                        <div className="text-[11px] text-slate-500">{accessLabel(cal)}</div>
                      </div>
                      <div className="flex w-full items-center gap-2 sm:w-auto">
                        {busyCal === cal.id && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
                        <select
                          className="input w-full py-1.5 text-xs sm:w-72"
                          value={use}
                          disabled={busyCal !== null}
                          onChange={(e) => void applyUse(cal.id, cal.name, e.target.value as CalUse)}
                          aria-label={`What to do with ${cal.name}`}
                        >
                          {USES.map((u) => (
                            <option key={u.value} value={u.value} disabled={u.writes && !writable}>
                              {u.label}
                              {u.writes && !writable ? " (view only)" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {use !== "off" && (
                      <div className="mt-2 pl-6 text-[11px] text-slate-500">
                        {info.hint}
                        {lastSynced &&
                          ` · Last synced ${new Date(lastSynced).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Create a calendar for the plan */}
              {googleCals && (
                <div className="rounded-xl border border-dashed border-slate-700 p-3.5">
                  {!showCreate ? (
                    <button onClick={() => setShowCreate(true)} className="flex w-full items-center justify-center gap-2 text-sm text-slate-300 hover:text-white">
                      <Plus className="h-4 w-4" /> Create a calendar just for the app's plan
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <div className="text-sm text-slate-200">New Google calendar for the plan</div>
                      <p className="text-xs text-slate-500">
                        It's created in {connectedEmail}'s Google Calendar and set as where the plan is written. Keeping the plan on its own calendar lets you
                        hide or show it in one tap.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <input className="input flex-1 min-w-[10rem]" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={DEFAULT_NEW_NAME} />
                        <button
                          onClick={() => void createCalendar()}
                          disabled={creating}
                          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                        >
                          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Create
                        </button>
                        <button onClick={() => setShowCreate(false)} className="rounded-lg px-3 py-2 text-xs text-slate-400 hover:bg-slate-800">
                          Cancel
                        </button>
                      </div>
                      {nameTaken && <div className="text-[11px] text-amber-300">You already have a calendar with this name. A second one will be made.</div>}
                    </div>
                  )}
                </div>
              )}

              {/* Where the plan goes */}
              {googleCals && (
                <div className="rounded-lg bg-slate-800/50 p-3 text-xs text-slate-400">
                  {writeTo ? (
                    <>
                      Planned tasks go to <span className="text-slate-200">{writeTo.tasks}</span>, habits to{" "}
                      <span className="text-slate-200">{writeTo.habits}</span>, family/personal blocks to{" "}
                      <span className="text-slate-200">{writeTo.personal}</span>.
                    </>
                  ) : (
                    <>Nothing is written to Google yet. Choose "Write the plan here" on a calendar, or create one for the app.</>
                  )}
                </div>
              )}
            </div>
          )}

          <StravaCard onChanged={() => setChanged(true)} />

          {/* Added by ID / leftovers */}
          {!loading && (
            <div className="rounded-xl border border-slate-800">
              <button
                onClick={() => setShowManual((v) => !v)}
                className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-slate-300 hover:bg-slate-800/40"
              >
                <span>
                  {connectedEmail ? "Other calendars (added by ID)" : "Calendars added by ID"}
                  {manualRows.length > 0 && <span className="ml-2 text-xs text-slate-500">{manualRows.length}</span>}
                </span>
                {showManual ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              {showManual && (
                <ManualRows
                  rows={manualRows}
                  onSaved={async (msg) => {
                    await loadConnections();
                    setChanged(true);
                    setMessage(msg);
                  }}
                  forgetPulledEvents={forgetPulledEvents}
                />
              )}
            </div>
          )}

          {message && <div className="text-sm text-slate-300">{message}</div>}
          {!statusChecked && <div className="text-xs text-slate-500">Checking your Google connection…</div>}
          <a
            href="https://support.google.com/calendar/answer/37082"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
          >
            Sharing and calendar settings in Google <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </div>
  );
}

/** The old by-ID editor, for calendars Google doesn't list (e.g. added by ID) and empty leftovers. */
function ManualRows({
  rows,
  onSaved,
  forgetPulledEvents,
}: {
  rows: CalendarConnection[];
  onSaved: (message: string) => Promise<void>;
  forgetPulledEvents: (calendarId: string) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<CalendarConnection[]>(rows);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDrafts(rows), [rows]);

  const update = (id: string, patch: Partial<CalendarConnection>) => setDrafts((cur) => cur.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  async function save(d: CalendarConnection) {
    if (!d.name.trim()) return setError("Each calendar needs a name.");
    if (!d.calendar_id.trim()) return setError("Add the calendar's ID (from its settings in Google Calendar), or delete this row.");
    setSavingId(d.id);
    setError(null);
    const payload = { name: d.name.trim(), calendar_id: d.calendar_id.trim(), role: d.role, enabled: d.enabled, updated_at: new Date().toISOString() };
    const { error: err } = d.id.startsWith("new-")
      ? await supabase.from("calendar_connections").insert(payload)
      : await supabase.from("calendar_connections").update(payload).eq("id", d.id);
    setSavingId(null);
    if (err) setError(`Could not save: ${err.message}`);
    else await onSaved(`${payload.name} saved.`);
  }

  async function remove(d: CalendarConnection) {
    if (d.id.startsWith("new-")) return setDrafts((cur) => cur.filter((x) => x.id !== d.id));
    const { error: err } = await supabase.from("calendar_connections").delete().eq("id", d.id);
    if (err) return setError(`Could not remove: ${err.message}`);
    if (d.calendar_id && SOURCE_ROLES.includes(d.role)) await forgetPulledEvents(d.calendar_id);
    await onSaved(`${d.name} removed.`);
  }

  return (
    <div className="space-y-3 border-t border-slate-800 p-4">
      <p className="text-xs text-slate-500">
        Only needed for a calendar Google doesn't list above. Rows without an ID don't do anything and can be deleted.
      </p>
      {drafts.map((d) => (
        <div key={d.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          <div className="grid gap-2 md:grid-cols-2">
            <label className="text-xs text-slate-400">
              Name
              <input className="input mt-1" value={d.name} onChange={(e) => update(d.id, { name: e.target.value })} />
            </label>
            <label className="text-xs text-slate-400">
              Use
              <select className="input mt-1" value={d.role} onChange={(e) => update(d.id, { role: e.target.value as CalendarRole })}>
                <option value="fixed_source">Block my time</option>
                <option value="display_only">Show only</option>
                <option value="schedule_target">Write the plan here</option>
              </select>
            </label>
          </div>
          <label className="mt-2 block text-xs text-slate-400">
            Google Calendar ID
            <input
              className="input mt-1"
              placeholder="something@group.calendar.google.com"
              value={d.calendar_id}
              onChange={(e) => update(d.id, { calendar_id: e.target.value })}
            />
          </label>
          {!d.calendar_id.trim() && <div className="mt-1 text-[11px] text-amber-300">Not linked to a calendar yet.</div>}
          <div className="mt-2 flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input type="checkbox" checked={d.enabled} onChange={(e) => update(d.id, { enabled: e.target.checked })} /> On
            </label>
            <div className="flex gap-2">
              <button onClick={() => void remove(d)} className="rounded-lg p-2 text-slate-500 hover:text-rose-400" aria-label={`Delete ${d.name}`}>
                <Trash2 className="h-4 w-4" />
              </button>
              <button
                onClick={() => void save(d)}
                disabled={savingId === d.id}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {savingId === d.id ? "Saving…" : <><Check className="h-3.5 w-3.5" /> Save</>}
              </button>
            </div>
          </div>
        </div>
      ))}
      <button
        onClick={() =>
          setDrafts((cur) => [...cur, { id: `new-${Date.now()}`, name: "New calendar", calendar_id: "", role: "fixed_source", enabled: true }])
        }
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-700 py-2.5 text-sm text-slate-400 hover:border-slate-500 hover:text-slate-200"
      >
        <Plus className="h-4 w-4" /> Add a calendar by ID
      </button>
      {error && <div className="text-xs text-rose-300">{error}</div>}
      <div className="flex items-center gap-1.5 text-[11px] text-slate-600">
        <Calendar className="h-3 w-3" /> Find an ID in Google Calendar → the calendar's Settings → Integrate calendar.
      </div>
    </div>
  );
}

/** Strava: finished runs come from here, so a run Runna's calendar drops still counts. */
function StravaCard({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<StravaStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => setStatus(await stravaStatus()), []);
  useEffect(() => {
    void load();
  }, [load]);

  const url = getStravaOAuthUrl(status?.clientId);
  const ago = (iso: string) => {
    const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
  };

  async function syncNow() {
    setBusy(true);
    setNote(null);
    const r = await stravaSync(30);
    setBusy(false);
    if (!r.success) setNote(r.error ?? "Sync failed.");
    else {
      setNote(`Checked ${r.runs ?? 0} runs from the last 30 days: ${r.added ?? 0} added, ${r.matched ?? 0} already on Runna's calendar.`);
      if (r.added || r.removed) onChanged();
    }
    await load();
  }

  async function disconnect() {
    setBusy(true);
    await stravaDisconnect();
    setBusy(false);
    setNote("Strava disconnected. Runs already added stay on your calendar.");
    await load();
  }

  return (
    <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          <div className="font-medium text-orange-100">
            Strava {status?.connected ? `· connected${status.athlete ? ` as ${status.athlete}` : ""}` : ""}
          </div>
          <div className="mt-0.5 text-xs text-orange-200/70">
            {status?.connected
              ? `Finished runs come from Strava, so a run Runna's calendar drops still counts.${status.lastSyncAt ? ` Last checked ${ago(status.lastSyncAt)}.` : ""}`
              : "Connect to bring in every finished run, even when Runna's calendar drops it."}
          </div>
        </div>
        {status?.connected ? (
          <div className="flex gap-2">
            <button onClick={() => void syncNow()} disabled={busy} className="flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2 text-xs font-medium text-white hover:bg-orange-500 disabled:opacity-50">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Sync now
            </button>
            <button onClick={() => void disconnect()} disabled={busy} className="rounded-lg border border-orange-300/30 px-3 py-2 text-xs font-medium text-orange-100 hover:bg-orange-500/20 disabled:opacity-50">
              Disconnect
            </button>
          </div>
        ) : (
          <button
            onClick={() => url && (window.location.href = url)}
            disabled={!url || status?.clientReady === false}
            className="rounded-lg bg-orange-600 px-3 py-2 text-xs font-medium text-white hover:bg-orange-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Connect Strava
          </button>
        )}
      </div>
      {status && !status.clientReady && <div className="mt-2 text-xs text-amber-200">Waiting for the STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET secrets.</div>}
      {status?.lastError && <div className="mt-2 text-xs text-rose-200">Last sync problem: {status.lastError}</div>}
      {note && <div className="mt-2 text-xs text-orange-100/80">{note}</div>}
    </div>
  );
}
