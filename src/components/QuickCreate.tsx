import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { supabase } from "@/lib/supabase";

/** A time range swept out on the calendar grid, waiting for a title. */
export interface QuickCreateRange {
  start: Date;
  end: Date;
  /** Names of things already on the calendar in that time (a warning, never a block). */
  overlaps: string[];
  /** Where the pointer was let go, so the box opens next to it on a computer. */
  x?: number;
  y?: number;
}

const p2 = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
export function durationText(start: Date, end: Date): string {
  const m = Math.round((end.getTime() - start.getTime()) / 60000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}
export const rangeText = (start: Date, end: Date) => `${hhmm(start)}–${hhmm(end)} · ${durationText(start, end)}`;

/**
 * Google-Calendar-style quick create: type a title, Enter saves a Fixed event
 * for the swept time. "More options" opens the full form with everything filled in.
 */
export function QuickCreate({
  range,
  onClose,
  onSaved,
  onMore,
}: {
  range: QuickCreateRange;
  onClose: () => void;
  onSaved: () => void;
  onMore: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const phone = typeof window !== "undefined" && window.innerWidth < 640;
  // The finger or mouse that just let go can land on the backdrop; don't let that close the box.
  const openedAt = useRef(Date.now());
  const closeFromBackdrop = () => {
    if (Date.now() - openedAt.current > 400) onClose();
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  async function save() {
    const n = name.trim();
    if (!n) {
      setError("Add a title first");
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    const { error: err } = await supabase.from("fixed_events").insert({
      name: n,
      start_time: range.start.toISOString(),
      end_time: range.end.toISOString(),
      is_all_day: false,
      pillar: null,
      recurrence_enabled: false,
    });
    if (err) {
      setError(err.message);
      setSaving(false);
      return;
    }
    onSaved();
    onClose();
  }

  const W = 320;
  const pos: React.CSSProperties = phone
    ? {}
    : {
        left: Math.max(8, Math.min((range.x ?? window.innerWidth / 2 - W / 2) + 14, window.innerWidth - W - 8)),
        top: Math.max(8, Math.min((range.y ?? window.innerHeight / 3) - 40, window.innerHeight - 240)),
        width: W,
      };
  const day = range.start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className={`fixed inset-0 z-[60] ${phone ? "bg-black/50 flex items-end" : ""}`} onMouseDown={closeFromBackdrop}>
      <div
        role="dialog"
        aria-label="New fixed event"
        className={`${phone ? "w-full rounded-t-3xl pb-[calc(16px+env(safe-area-inset-bottom))]" : "fixed rounded-xl"} border border-slate-700 bg-slate-900 p-4 shadow-2xl shadow-black/60`}
        style={pos}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">New fixed event</span>
          <button onClick={onClose} className="ml-auto p-1 rounded-lg hover:bg-slate-800" aria-label="Close">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>
        <input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder="Add title"
          enterKeyHint="done"
          className="w-full bg-transparent border-b-2 border-slate-700 focus:border-blue-500 outline-none py-1.5 text-lg text-slate-100 placeholder:text-slate-500"
        />
        <p className="mt-2.5 text-sm text-slate-300 tabular-nums">
          {day} · {rangeText(range.start, range.end)}
        </p>
        {range.overlaps.length > 0 && (
          <p className="mt-1 text-xs text-amber-300">
            Overlaps {range.overlaps.slice(0, 3).join(", ")}
            {range.overlaps.length > 3 ? ` +${range.overlaps.length - 3} more` : ""}
          </p>
        )}
        {error && <p className="mt-1.5 text-xs text-rose-300">{error}</p>}
        <div className="mt-3 flex items-center gap-2">
          <button onClick={() => onMore(name.trim())} className="text-sm text-blue-400 hover:underline">
            More options
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="ml-auto flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
