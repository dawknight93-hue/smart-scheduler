import { useEffect, useState } from "react";
import { Activity, CheckCircle2 } from "lucide-react";
import { stravaExchange } from "@/lib/gcalSync";

/** Strava sends you back here after you approve the connection. */
export function StravaCallback() {
  const [message, setMessage] = useState("Connecting Strava…");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (params.get("error") || !code) {
      setMessage("Strava wasn't connected (the request was cancelled or declined).");
      return;
    }
    if (!(params.get("scope") ?? "").includes("activity:read")) {
      setMessage("Strava didn't share your activities. Connect again and keep the box to view your activities ticked.");
      return;
    }
    void stravaExchange(code).then((r) => {
      if (!r.success) {
        setMessage(r.error || "Strava connection could not be completed.");
        return;
      }
      setSuccess(true);
      setMessage(
        r.syncError
          ? `Strava is connected${r.athlete ? ` for ${r.athlete}` : ""}. The first sync hit a problem: ${r.syncError}`
          : `Strava is connected${r.athlete ? ` for ${r.athlete}` : ""}. ${r.added ?? 0} run${r.added === 1 ? "" : "s"} from the last 30 days added.`
      );
      window.history.replaceState({}, "", "/");
      window.setTimeout(() => {
        window.location.href = "/";
      }, 2500);
    });
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
      <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center shadow-2xl">
        {success ? <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-emerald-400" /> : <Activity className="mx-auto mb-4 h-12 w-12 animate-pulse text-orange-400" />}
        <h1 className="text-lg font-semibold">Smart Scheduler</h1>
        <p className="mt-2 text-sm text-slate-400">{message}</p>
      </div>
    </main>
  );
}
