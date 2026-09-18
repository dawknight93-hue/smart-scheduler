import { useState } from "react";
import { CalendarDays, CheckSquare, CalendarClock, Target } from "lucide-react";
import { CalendarView } from "@/components/CalendarView";
import { TasksView } from "@/components/TasksView";
import { GoalsView } from "@/components/GoalsView";
import { GoogleCallback } from "@/components/GoogleCallback";
import { getWeekStart } from "@/lib/schedulingEngine";

type View = "calendar" | "tasks" | "goals";

function App() {
  const [view, setView] = useState<View>("calendar");
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));

  if (window.location.pathname === "/gcal-callback") return <GoogleCallback />;

  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-slate-950 text-slate-100 flex flex-col">
      {/* Tab bar */}
      <nav className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="px-4 py-2 flex items-center gap-1">
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
        </div>
      </nav>

      {view === "calendar" ? (
        <CalendarView
          weekStart={weekStart}
          setWeekStart={setWeekStart}
        />
      ) : view === "tasks" ? (
        <TasksView weekStart={weekStart} />
      ) : (
        <GoalsView />
      )}
    </div>
  );
}

export default App;
