import { useEffect, useState } from "react";
import { CalendarDays, CheckCircle2 } from "lucide-react";
import { exchangeOAuthCode } from "@/lib/gcalSync";

export function GoogleCallback() {
  const [message, setMessage] = useState("Connecting your Google account…");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("code");
    if (!code) {
      setMessage("Google did not return an authorization code.");
      return;
    }

    void exchangeOAuthCode(code).then((result) => {
      if (!result.success) {
        setMessage(result.error || "Google connection could not be completed.");
        return;
      }
      setSuccess(true);
      setMessage("Google Calendar is connected.");
      window.history.replaceState({}, "", "/");
      window.setTimeout(() => { window.location.href = "/"; }, 1200);
    });
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
      <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-8 text-center shadow-2xl">
        {success ? <CheckCircle2 className="mx-auto mb-4 h-12 w-12 text-emerald-400" /> : <CalendarDays className="mx-auto mb-4 h-12 w-12 animate-pulse text-blue-400" />}
        <h1 className="text-lg font-semibold">Smart Scheduler</h1>
        <p className="mt-2 text-sm text-slate-400">{message}</p>
      </div>
    </main>
  );
}
