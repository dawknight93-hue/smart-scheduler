import { useState } from "react";
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

type View = "briefing" | "calendar" | "tasks" | "goals" | "review";

function App() {
  const [view, setView] = useState<View>("calendar");
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const reviewDue = useReviewDue(view);

  if (window.location.pathname === "/gcal-callback") return <GoogleCallback />;
  if (window.location.pathname === "/privacy") return <PrivacyPolicy />;

  return (
    <div
      className={`w-full overflow-x-hidden bg-slate-950 text-slate-100 flex flex-col ${
        // Calendar: fixed to the screen so only the hour grid scrolls and the
        // tabs, header, day names and all-day row stay frozen at the top.
        view === "calendar" ? "h-[100dvh] overflow-y-hidden" : "min-h-screen"
      }`}
    >
      {/* Tab bar */}
      <nav className="shrink-0 border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="px-4 py-2 flex items-center gap-1 overflow-x-auto">
          <button
            onClick={() => setView("briefing")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              view === "briefing"
                ? "bg-blue-600 text-white"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            }`}
          >
            <Sunrise className="w-4 h-4" />
            Briefing
          </button>
          <button
            onClick={() => setView("calendar")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              view === "calendar"
                ? "bg-blue-600 text-white"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            }`}
          >
            <CalendarDays className="w-4 h-4" />
            Calendar
          </button>
          <button
            onClick={() => setView("tasks")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              view === "tasks"
                ? "bg-blue-600 text-white"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            }`}
          >
            <CheckSquare className="w-4 h-4" />
            Tasks
          </button>
          <button
            onClick={() => setView("goals")}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              view === "goals"
                ? "bg-blue-600 text-white"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            }`}
          >
            <Target className="w-4 h-4" />
            Goals
          </button>
          <button
            onClick={() => setView("review")}
            className={`relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              view === "review"
                ? "bg-blue-600 text-white"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"
            }`}
          >
            <ClipboardCheck className="w-4 h-4" />
            Review
            {reviewDue && view !== "review" && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-amber-400" aria-label="Weekly Review due" />
            )}
          </button>
        </div>
      </nav>

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
  );
}

export default App;
