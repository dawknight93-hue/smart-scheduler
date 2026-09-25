import { useEffect, useState } from "react";
import { CalendarDays, CheckSquare, Target, ClipboardCheck, Sunrise } from "lucide-react";
import { CalendarView } from "@/components/CalendarView";
import { TasksView } from "@/components/TasksView";
import { GoalsView } from "@/components/GoalsView";
import { WeeklyReview } from "@/components/WeeklyReview";
import { BriefingView } from "@/components/BriefingView";
import { useReviewDue } from "@/lib/useReviewDue";
import { GoogleCallback } from "@/components/GoogleCallback";
import { PrivacyPolicy } from "@/components/PrivacyPolicy";
import { getWeekStart } from "@/lib/schedulingEngine";
import { registerServiceWorker } from "@/lib/push";
import { syncReminders } from "@/lib/reminders";

type View = "briefing" | "calendar" | "tasks" | "goals" | "review";
const VIEWS: View[] = ["briefing", "calendar", "tasks", "goals", "review"];

/** A tapped notification opens the app at ?view=briefing. */
function initialView(): View {
  const v = new URLSearchParams(window.location.search).get("view") as View | null;
  return v && VIEWS.includes(v) ? v : "calendar";
}

function App() {
  const [view, setView] = useState<View>(initialView);

  // Service worker (for notifications) and the next week's reminders, on launch
  // and whenever the app comes back to the foreground.
  useEffect(() => {
    if (window.location.pathname !== "/") return;
    void registerServiceWorker();
    const plan = () => void syncReminders().catch(() => undefined);
    plan();
    const onVisible = () => document.visibilityState === "visible" && plan();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const reviewDue = useReviewDue(view);

  if (window.location.pathname === "/gcal-callback") return <GoogleCallback />;
  if (window.location.pathname === "/privacy") return <PrivacyPolicy />;

  const tabs: { id: View; label: string; icon: typeof Sunrise }[] = [
    { id: "briefing", label: "Briefing", icon: Sunrise },
    { id: "calendar", label: "Calendar", icon: CalendarDays },
    { id: "tasks", label: "Tasks", icon: CheckSquare },
    { id: "goals", label: "Goals", icon: Target },
    { id: "review", label: "Review", icon: ClipboardCheck },
  ];
  const tabButton = (t: (typeof tabs)[number], vertical: boolean) => {
    const Icon = t.icon;
    const active = view === t.id;
    return (
      <button
        key={t.id}
        onClick={() => setView(t.id)}
        aria-current={active ? "page" : undefined}
        className={`relative flex items-center gap-2 rounded-lg text-sm font-medium transition-colors ${
          vertical ? "w-full px-3 py-2" : "px-4 py-2 shrink-0"
        } ${active ? "bg-blue-600 text-white" : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"}`}
      >
        <Icon className="w-4 h-4 shrink-0" />
        {t.label}
        {t.id === "review" && reviewDue && !active && (
          <span
            className={`w-2 h-2 rounded-full bg-amber-400 ${vertical ? "ml-auto" : "absolute top-1.5 right-1.5"}`}
            aria-label="Weekly Review due"
          />
        )}
      </button>
    );
  };

  return (
    <div
      className={`w-full overflow-x-clip bg-slate-950 text-slate-100 flex flex-col md:flex-row ${
        // Calendar: fixed to the screen so only the hour grid scrolls and the
        // tabs, header, day names and all-day row stay frozen.
        view === "calendar" ? "h-[100dvh] overflow-y-hidden" : "min-h-screen"
      }`}
    >
      {/* Tabs — a block on the left on wider screens (frees the top for the calendar) */}
      <aside className="hidden md:block w-44 shrink-0 border-r border-slate-800 bg-slate-900/60 md:sticky md:top-0 md:h-[100dvh]">
        <nav className="p-3" aria-label="Sections">
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-1.5 flex flex-col gap-0.5">
            {tabs.map((t) => tabButton(t, true))}
          </div>
        </nav>
      </aside>

      {/* Tabs — top bar on phones, where a side column would crowd the calendar */}
      <nav className="md:hidden shrink-0 border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-40" aria-label="Sections">
        <div className="px-4 py-2 flex items-center gap-1 overflow-x-auto">{tabs.map((t) => tabButton(t, false))}</div>
      </nav>

      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
      {view === "calendar" ? (
        <CalendarView
          weekStart={weekStart}
          setWeekStart={setWeekStart}
        />
      ) : view === "tasks" ? (
        <TasksView weekStart={weekStart} />
      ) : view === "briefing" ? (
        <BriefingView onOpenReview={() => setView("review")} />
      ) : view === "review" ? (
        <WeeklyReview onOpenGoals={() => setView("goals")} />
      ) : (
        <GoalsView />
      )}
      </div>
    </div>
  );
}

export default App;
