import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Loader2, Send, Smartphone, X } from "lucide-react";
import { disablePush, enablePush, pushStatus, pushSupport, sendTestPush, type PushStatus } from "@/lib/push";
import {
  DEFAULT_SETTINGS,
  loadReminderSettings,
  recentReminders,
  saveReminderSettings,
  syncReminders,
  upcomingReminders,
  type ReminderRow,
  type ReminderSettings,
} from "@/lib/reminders";

const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Turn notifications on for this phone, choose which reminders to get, and see what's scheduled. */
export function RemindersPanel({ onClose }: { onClose: () => void }) {
  const support = pushSupport();
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [settings, setSettings] = useState<ReminderSettings>(DEFAULT_SETTINGS);
  const [upcoming, setUpcoming] = useState<ReminderRow[]>([]);
  const [recent, setRecent] = useState<ReminderRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    const [st, s, up, rc] = await Promise.all([pushStatus().catch(() => null), loadReminderSettings(), upcomingReminders(), recentReminders()]);
    setStatus(st);
    setSettings(s);
    setUpcoming(up);
    setRecent(rc);
  }, []);

  useEffect(() => {
    void (async () => {
      await syncReminders(true).catch(() => undefined);
      await refresh();
    })();
  }, [refresh]);

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(label);
    setMessage(null);
    try {
      const text = await fn();
      if (text) setMessage({ tone: "ok", text });
      await refresh();
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "Something went wrong" });
    } finally {
      setBusy(null);
    }
  }

  async function update(patch: Partial<ReminderSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    await run("save", async () => {
      await saveReminderSettings(next);
      await syncReminders(true);
    });
  }

  const on = !!status?.thisDevice && support.permission === "granted";
  const needsHomeScreen = support.isIos && !support.standalone;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-6" onClick={onClose}>
      <div className="w-full max-w-lg max-h-[92dvh] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-4 sm:p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Reminders</h2>
            <p className="text-xs text-slate-400 mt-0.5">Notifications on this phone for your morning briefing and reserve days.</p>
          </div>
          <button onClick={onClose} className="ml-auto p-1.5 rounded-lg hover:bg-slate-800" aria-label="Close">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        {/* This device */}
        <section className="rounded-xl border border-slate-700 bg-slate-800/50 p-3 mb-3">
          <div className="flex items-center gap-2 text-sm text-slate-200">
            <Smartphone className="w-4 h-4 text-slate-400" />
            This device:
            <span className={on ? "text-emerald-400 font-medium" : "text-slate-400"}>{on ? "notifications on" : "notifications off"}</span>
            {status && <span className="ml-auto text-[11px] text-slate-500">{status.devices} device{status.devices === 1 ? "" : "s"} signed up</span>}
          </div>
          {needsHomeScreen ? (
            <p className="mt-2 text-xs text-amber-300/90">
              Open Smart Scheduler from its Home Screen icon to turn these on — a Safari tab can't get notifications. If you added it to your Home Screen before today, remove that icon and add it again (Share → Add to Home Screen) so it picks up the new app settings.
            </p>
          ) : !support.supported ? (
            <p className="mt-2 text-xs text-slate-400">This browser can't receive notifications.</p>
          ) : null}
          {status?.lastError && <p className="mt-2 text-xs text-rose-300">Last send failed: {status.lastError}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {!on ? (
              <button
                disabled={!!busy || !support.supported}
                onClick={() => run("enable", async () => {
                  await enablePush();
                  await syncReminders(true);
                  return "Notifications are on for this device.";
                })}
                className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {busy === "enable" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />} Turn on notifications
              </button>
            ) : (
              <button
                disabled={!!busy}
                onClick={() => run("disable", async () => {
                  await disablePush();
                  return "Notifications are off for this device.";
                })}
                className="flex items-center gap-1.5 rounded-lg bg-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-600 disabled:opacity-50"
              >
                <BellOff className="w-4 h-4" /> Turn off here
              </button>
            )}
            <button
              disabled={!!busy || !status?.devices}
              onClick={() => run("test", async () => {
                const results = await sendTestPush();
                const ok = results.filter((r) => r.result === "ok").length;
                return ok ? `Test sent to ${ok} device${ok === 1 ? "" : "s"} — it should arrive in a few seconds.` : `Test failed: ${results.map((r) => r.result).join("; ") || "no devices"}`;
              })}
              className="flex items-center gap-1.5 rounded-lg bg-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-600 disabled:opacity-50"
            >
              {busy === "test" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send a test
            </button>
          </div>
          {message && <p className={`mt-2 text-xs ${message.tone === "ok" ? "text-emerald-400" : "text-rose-300"}`}>{message.text}</p>}
        </section>

        {/* What to send */}
        <section className="rounded-xl border border-slate-700 bg-slate-800/50 p-3 mb-3 space-y-2.5">
          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input type="checkbox" className="accent-blue-500" checked={settings.enabled} onChange={(e) => void update({ enabled: e.target.checked })} />
            Send reminders
          </label>
          <div className={`space-y-2.5 pl-6 ${settings.enabled ? "" : "opacity-50 pointer-events-none"}`}>
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-200">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="accent-blue-500" checked={settings.morning} onChange={(e) => void update({ morning: e.target.checked })} />
                Morning briefing at
              </label>
              <input
                type="time"
                value={settings.morning_time}
                onChange={(e) => setSettings({ ...settings, morning_time: e.target.value })}
                onBlur={(e) => /^\d{2}:\d{2}$/.test(e.target.value) && void update({ morning_time: e.target.value })}
                className="rounded-lg bg-slate-950 border border-slate-700 px-2 py-1 text-sm text-slate-100"
              />
            </div>
            <label className="flex items-start gap-2 text-sm text-slate-200">
              <input type="checkbox" className="accent-blue-500 mt-1" checked={settings.weekly} onChange={(e) => void update({ weekly: e.target.checked })} />
              <span>
                Weekly Review — Sundays at 21:30
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-slate-200">
              <input type="checkbox" className="accent-blue-500 mt-1" checked={settings.monthly} onChange={(e) => void update({ monthly: e.target.checked })} />
              <span>
                Monthly briefing — last day of the month at 20:00
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-slate-200">
              <input type="checkbox" className="accent-blue-500 mt-1" checked={settings.trips} onChange={(e) => void update({ trips: e.target.checked })} />
              <span>
                New trip alerts
                <span className="block text-xs text-slate-400">When a flight shows up on your calendar for the next few days (like a reserve assignment). Your calendars are checked every 15 minutes, even with the app closed.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-slate-200">
              <input type="checkbox" className="accent-blue-500 mt-1" checked={settings.reserve} onChange={(e) => void update({ reserve: e.target.checked })} />
              <span>
                Day before a reserve day
                <span className="block text-xs text-slate-400">When the proffer window opens, when assignments start posting, and 30 min before the confirm-by time. Times come from your Awareness rules (Proffer window, Airline reserve).</span>
              </span>
            </label>
          </div>
        </section>

        {/* Scheduled */}
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1.5">Scheduled (next 7 days)</h3>
          {upcoming.length ? (
            <ul className="space-y-1.5">
              {upcoming.map((r) => (
                <li key={r.id} className="rounded-lg bg-slate-800/60 px-3 py-2">
                  <div className="flex gap-2 text-xs">
                    <span className="text-slate-400 tabular-nums shrink-0">{when(r.send_at)}</span>
                    <span className="text-slate-200 font-medium">{r.title}</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">{r.body}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-slate-500">Nothing scheduled.</p>
          )}
          <p className="mt-2 text-[11px] text-slate-500">Detailed reminders (briefing contents, reserve times, numbers to log) are planned from your calendar each time you open the app. The weekly, monthly and trip reminders come from the server, and if the app wasn't opened, a plain morning nudge still arrives.</p>
          {recent.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-slate-400">Recently sent</summary>
              <ul className="mt-1 space-y-1">
                {recent.map((r) => (
                  <li key={r.id} className="text-[11px] text-slate-500">
                    {when(r.send_at)} · {r.title} — {r.status ?? "sent"}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      </div>
    </div>
  );
}
