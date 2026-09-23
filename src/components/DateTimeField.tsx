import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Date + time picker styled like the rest of the app (and laid out like Google
 * Calendar's): a date button that opens a month calendar, and a 24-hour time
 * box you can type into or pick from a 15-minute list.
 *
 * Values use the same "YYYY-MM-DDTHH:MM" local format as <input type="datetime-local">.
 */

const pad = (n: number) => String(n).padStart(2, "0");

function splitValue(v: string): { date: string; time: string } {
  const [date = "", time = "00:00"] = v.split("T");
  return { date, time: time.slice(0, 5) };
}

function parseDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function toDateString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function timeOf(mins: number): string {
  return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
}

/** Accepts "17:30", "1730", "930", "9", "5:30pm", "5 pm". Returns "HH:MM" (24-hour) or null. */
function parseTimeInput(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, "");
  const m = s.match(/^(\d{1,4})(?::(\d{1,2}))?(am|pm|a|p)?$/);
  if (!m) return null;
  let h: number;
  let min: number;
  if (m[2] !== undefined) {
    if (m[1].length > 2) return null;
    h = Number(m[1]);
    min = Number(m[2]);
  } else {
    const d = m[1];
    if (d.length <= 2) { h = Number(d); min = 0; }
    else if (d.length === 3) { h = Number(d[0]); min = Number(d.slice(1)); }
    else { h = Number(d.slice(0, 2)); min = Number(d.slice(2)); }
  }
  const ampm = m[3];
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm.startsWith("p") && h !== 12) h += 12;
    if (ampm.startsWith("a") && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = +(mins / 60).toFixed(2);
  return `${h} hr${h === 1 ? "" : "s"}`;
}

/** Keeps a popover pinned under (or above) its anchor, even inside a scrolling modal. */
function usePopoverPosition(open: boolean, anchor: React.RefObject<HTMLElement>, height: number) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      const top = below < height + 12 && r.top > below ? r.top - height - 6 : r.bottom + 6;
      setPos({ top, left: r.left, width: r.width });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, height]);
  return pos;
}

/** Closes a popover on outside click or Escape. */
function useDismiss(open: boolean, refs: React.RefObject<HTMLElement>[], onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (refs.some((r) => r.current?.contains(e.target as Node))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, refs, onClose]);
}

// ---------------------------------------------------------------------------

export function DateField({
  value,
  onChange,
  disabled,
  className = "",
}: {
  value: string; // "YYYY-MM-DD"
  onChange: (date: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const selected = value ? parseDate(value) : new Date();
  const [month, setMonth] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));
  const pos = usePopoverPosition(open, btn, 300);
  useDismiss(open, [btn, pop], () => setOpen(false));

  useEffect(() => {
    if (open) setMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const days = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const offset = (first.getDay() + 6) % 7; // Monday-first, like the rest of the app
    const start = new Date(first);
    start.setDate(1 - offset);
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [month]);

  const today = new Date().toDateString();
  const sameYear = selected.getFullYear() === new Date().getFullYear();
  const label = value
    ? selected.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })
    : "Pick a date";

  return (
    <>
      <button
        ref={btn}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`input text-left truncate disabled:opacity-50 disabled:cursor-not-allowed ${open ? "border-blue-500 ring-1 ring-blue-500" : ""} ${className}`}
      >
        {label}
      </button>
      {open && pos &&
        createPortal(
          <div
            ref={pop}
            className="fixed z-[70] w-64 rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl"
            style={{ top: pos.top, left: Math.min(pos.left, window.innerWidth - 272) }}
          >
            <div className="mb-2 flex items-center justify-between">
              <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="rounded p-1 hover:bg-slate-800" aria-label="Previous month">
                <ChevronLeft className="h-4 w-4 text-slate-400" />
              </button>
              <span className="text-sm font-medium text-slate-100">
                {month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
              </span>
              <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="rounded p-1 hover:bg-slate-800" aria-label="Next month">
                <ChevronRight className="h-4 w-4 text-slate-400" />
              </button>
            </div>
            <div className="mb-1 grid grid-cols-7 gap-1">
              {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                <div key={i} className="text-center text-[10px] font-medium text-slate-500">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {days.map((d) => {
                const isSel = value && d.toDateString() === selected.toDateString();
                const isToday = d.toDateString() === today;
                const inMonth = d.getMonth() === month.getMonth();
                return (
                  <button
                    key={d.toISOString()}
                    type="button"
                    onClick={() => {
                      onChange(toDateString(d));
                      setOpen(false);
                    }}
                    className={`flex aspect-square items-center justify-center rounded-full text-xs transition-colors ${
                      isSel
                        ? "bg-blue-600 font-semibold text-white"
                        : isToday
                        ? "font-semibold text-blue-400 ring-1 ring-blue-500"
                        : inMonth
                        ? "text-slate-200 hover:bg-slate-800"
                        : "text-slate-600 hover:bg-slate-800"
                    }`}
                  >
                    {d.getDate()}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

// ---------------------------------------------------------------------------

export function TimeField({
  value,
  onChange,
  durationFrom,
  className = "",
}: {
  value: string; // "HH:MM" (24-hour)
  onChange: (time: string) => void;
  /** If set ("HH:MM" on the same day), list entries after it show a duration like Google's "(1 hr)". */
  durationFrom?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pos = usePopoverPosition(open, input, 240);

  useEffect(() => setText(value), [value]);

  const options = useMemo(() => {
    const opts: string[] = [];
    const startAt = durationFrom ? minutesOf(durationFrom) : 0;
    for (let m = 0; m < 24 * 60; m += 15) opts.push(timeOf(m));
    // Like Google: the end-time list starts at the start time.
    return durationFrom ? opts.filter((t) => minutesOf(t) >= startAt) : opts;
  }, [durationFrom]);

  const commit = (raw: string) => {
    const t = parseTimeInput(raw);
    if (t) {
      onChange(t);
      setText(t);
    } else {
      setText(value);
    }
  };

  const close = () => {
    setOpen(false);
    commit(text);
  };
  useDismiss(open, [input, pop], close);

  // Scroll the list so the current time is in view (and highlighted) when it opens.
  useEffect(() => {
    if (!open) return;
    const cur = minutesOf(value);
    let idx = options.findIndex((t) => minutesOf(t) >= cur);
    if (idx < 0) idx = options.length - 1;
    setActive(idx);
    requestAnimationFrame(() => {
      const el = list.current?.children[idx] as HTMLElement | undefined;
      if (el && list.current) list.current.scrollTop = el.offsetTop - list.current.clientHeight / 2 + el.clientHeight / 2;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || active < 0) return;
    const el = list.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  return (
    <>
      <input
        ref={input}
        value={text}
        inputMode="numeric"
        aria-label="Time (24-hour)"
        onFocus={(e) => {
          setOpen(true);
          e.currentTarget.select();
        }}
        onClick={() => setOpen(true)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.max(0, Math.min(options.length - 1, a + (e.key === "ArrowDown" ? 1 : -1))));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (open && active >= 0 && parseTimeInput(text) === value) commit(options[active]);
            else commit(text);
            setOpen(false);
          } else if (e.key === "Tab") {
            commit(text);
            setOpen(false);
          }
        }}
        className={`input w-[5.5rem] text-center tabular-nums ${open ? "border-blue-500 ring-1 ring-blue-500" : ""} ${className}`}
      />
      {open && pos &&
        createPortal(
          <div
            ref={pop}
            className="fixed z-[70] w-44 overflow-hidden rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-2xl"
            style={{ top: pos.top, left: Math.min(pos.left, window.innerWidth - 184) }}
          >
            <div ref={list} className="max-h-56 overflow-y-auto">
              {options.map((t, i) => {
                const dur = durationFrom ? minutesOf(t) - minutesOf(durationFrom) : null;
                const isSel = t === value;
                return (
                  <button
                    key={t}
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => {
                      onChange(t);
                      setText(t);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm tabular-nums transition-colors ${
                      isSel ? "bg-blue-600/20 text-blue-300" : i === active ? "bg-slate-800 text-slate-100" : "text-slate-300"
                    }`}
                  >
                    <span>{t}</span>
                    {dur !== null && <span className="text-xs text-slate-500">({dur === 0 ? "0 min" : formatDuration(dur)})</span>}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

// ---------------------------------------------------------------------------

/** Date button + 24-hour time box, side by side. */
export function DateTimeField({
  value,
  onChange,
  durationFrom,
}: {
  value: string; // "YYYY-MM-DDTHH:MM"
  onChange: (v: string) => void;
  /** Start value ("YYYY-MM-DDTHH:MM"); when on the same date, the time list shows durations from it. */
  durationFrom?: string;
}) {
  const { date, time } = splitValue(value);
  const from = durationFrom ? splitValue(durationFrom) : null;
  return (
    <div className="flex gap-2">
      <DateField value={date} onChange={(d) => onChange(`${d}T${time}`)} className="flex-1 min-w-0" />
      <TimeField
        value={time}
        onChange={(t) => onChange(`${date}T${t}`)}
        durationFrom={from && from.date === date ? from.time : null}
      />
    </div>
  );
}
