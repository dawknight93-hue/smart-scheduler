import { useEffect, useState } from "react";
import { Calendar, Check, Download, ExternalLink, Link2, Plus, Settings, Trash2, Upload, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { CalendarConnection, CalendarRole } from "@/lib/types";
import { disconnectGoogle, getOAuthUrl, getSyncStatus, isGoogleConfigured } from "@/lib/gcalSync";

const initialConnections: CalendarConnection[] = [
  { id: "work", name: "Duty / Work", calendar_id: "", role: "fixed_source", enabled: true },
  { id: "personal", name: "Personal / Family", calendar_id: "", role: "fixed_source", enabled: true },
  { id: "tasks", name: "Generated Tasks", calendar_id: "", role: "schedule_target", enabled: true },
  { id: "habits", name: "Generated Habits", calendar_id: "", role: "schedule_target", enabled: true },
];

export function CalendarConnectionsPanel({ onClose }: { onClose: () => void }) {
  const [connections, setConnections] = useState<CalendarConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null);

  useEffect(() => {
    void loadConnections();
    void loadStatus();
  }, []);

  async function loadStatus() {
    const status = await getSyncStatus();
    setConnectedEmail(status?.connected ? status.email : null);
  }

  async function connectGoogle() {
    const url = getOAuthUrl();
    if (!url) {
      setMessage("Google authorization is not configured yet.");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function disconnect() {
    const result = await disconnectGoogle();
    setMessage(result.success ? "Google account disconnected." : "Could not disconnect Google.");
    setConnectedEmail(null);
  }

  async function loadConnections() {
    const { data, error } = await supabase.from("calendar_connections").select("*").order("created_at");
    if (error) {
      setMessage("Could not load calendar settings.");
      setConnections(initialConnections);
    } else {
      setConnections((data as CalendarConnection[]) ?? initialConnections);
    }
    setLoading(false);
  }

  async function saveConnection(connection: CalendarConnection) {
    if (!connection.name.trim()) {
      setMessage("Each calendar needs a name.");
      return;
    }
    setSavingId(connection.id);
    setMessage(null);
    const payload = {
      name: connection.name.trim(),
      calendar_id: connection.calendar_id.trim(),
      role: connection.role,
      enabled: connection.enabled,
      updated_at: new Date().toISOString(),
    };
    const query = connection.id.length > 20
      ? supabase.from("calendar_connections").update(payload).eq("id", connection.id)
      : supabase.from("calendar_connections").insert(payload);
    const { error } = await query;
    setSavingId(null);
    if (error) {
      setMessage("Could not save this calendar setting.");
    } else {
      setMessage("Calendar setting saved.");
      await loadConnections();
    }
  }

  async function removeConnection(id: string) {
    if (id.length <= 20) return;
    const { error } = await supabase.from("calendar_connections").delete().eq("id", id);
    if (error) setMessage("Could not remove this calendar setting.");
    else await loadConnections();
  }

  function updateConnection(id: string, patch: Partial<CalendarConnection>) {
    setConnections((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function addConnection() {
    setConnections((current) => [
      ...current,
      { id: `new-${Date.now()}`, name: "New calendar", calendar_id: "", role: "fixed_source", enabled: true },
    ]);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/15 text-blue-400"><Settings className="h-5 w-5" /></div>
            <div><h2 className="font-semibold">Google Calendar connections</h2><p className="text-xs text-slate-400">Four separate roles for the scheduling engine</p></div>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 hover:bg-slate-800"><X className="h-5 w-5 text-slate-400" /></button>
        </div>

        <div className="space-y-4 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 p-4">
            <div className="text-sm text-blue-100">
              <div className="font-medium">{connectedEmail ? `Connected as ${connectedEmail}` : "Connect Google Calendar"}</div>
              <div className="mt-1 text-xs text-blue-200/70">{connectedEmail ? "Sync can now read and write the calendars below." : "Authorize access once, then use the four calendar roles below."}</div>
            </div>
            {connectedEmail ? <div className="flex gap-2"><button onClick={() => void connectGoogle()} disabled={!isGoogleConfigured()} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">Reconnect</button><button onClick={() => void disconnect()} className="rounded-lg border border-blue-300/30 px-3 py-2 text-xs font-medium text-blue-100 hover:bg-blue-500/20">Disconnect</button></div> : <button onClick={() => void connectGoogle()} disabled={!isGoogleConfigured()} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">Connect Google</button>}
          </div>
          {!isGoogleConfigured() && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">Google authorization is waiting for the app’s Google client ID.</div>}

          {loading ? <div className="py-10 text-center text-sm text-slate-500">Loading calendar settings…</div> : connections.map((connection) => (
            <div key={connection.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="flex items-center gap-2"><Calendar className="h-4 w-4 text-slate-500" /><span className="text-sm font-medium">{connection.role === "fixed_source" ? "Blocking source" : connection.role === "display_only" ? "Display-only source" : "Write target"}</span>{connection.role === "schedule_target" ? <span className="flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400"><Upload className="h-2.5 w-2.5" /> Push</span> : <span className="flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400"><Download className="h-2.5 w-2.5" /> {connection.role === "display_only" ? "Display" : "Pull"}</span>}</div>
                {connection.id.length > 20 && <button onClick={() => void removeConnection(connection.id)} className="text-slate-500 hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-xs text-slate-400">Display name<input className="input mt-1" value={connection.name} onChange={(event) => updateConnection(connection.id, { name: event.target.value })} /></label>
                <label className="text-xs text-slate-400">Role<select className="input mt-1" value={connection.role} onChange={(event) => updateConnection(connection.id, { role: event.target.value as CalendarRole })}><option value="fixed_source">Blocking source (pull events in)</option><option value="display_only">Display-only source (does not block)</option><option value="schedule_target">Write target (push schedule out)</option></select></label>
              </div>
              <label className="mt-3 block text-xs text-slate-400">Google Calendar ID<input className="input mt-1" placeholder="your-calendar-id@group.calendar.google.com" value={connection.calendar_id} onChange={(event) => updateConnection(connection.id, { calendar_id: event.target.value })} /></label>
              {connection.last_synced_at && <div className="mt-2 text-[10px] text-slate-500">Last synced {new Date(connection.last_synced_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</div>}
              <div className="mt-3 flex items-center justify-between"><label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={connection.enabled} onChange={(event) => updateConnection(connection.id, { enabled: event.target.checked })} /> Enabled</label><button onClick={() => void saveConnection(connection)} disabled={savingId === connection.id} className="flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50">{savingId === connection.id ? "Saving…" : <><Check className="h-3.5 w-3.5" /> Save</>}</button></div>
            </div>
          ))}

          <button onClick={addConnection} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-700 py-3 text-sm text-slate-400 hover:border-slate-500 hover:text-slate-200"><Plus className="h-4 w-4" /> Add another calendar</button>
          {message && <div className="text-sm text-slate-400">{message}</div>}
          <div className="flex items-center gap-2 text-xs text-slate-500"><Link2 className="h-3.5 w-3.5" /> Tokens will be handled server-side when Google authorization is enabled.</div>
          <a href="https://support.google.com/calendar/answer/37082" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300">How to find a Calendar ID <ExternalLink className="h-3 w-3" /></a>
        </div>
      </div>
    </div>
  );
}
