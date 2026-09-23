import type { Task, FixedEvent, Habit } from "./types";

export interface RecurrenceRule {
  enabled: boolean;
  frequency: "daily" | "weekly" | "monthly";
  interval: number;
  weekdays: number[];
  monthlyMode: "day_of_month" | "weekday_of_month";
  monthlyDay: number;
  monthlyWeekN: number;
  monthlyWeekday: number;
  endMode: "never" | "on_date" | "after_count";
  endDate: string | null;
  count: number | null;
}

type RecurrenceSource = Task | FixedEvent | Habit;

export function parseRecurrenceFromItem(item: RecurrenceSource): RecurrenceRule {
  return {
    enabled: item.recurrence_enabled ?? false,
    frequency: (item.recurrence_frequency as RecurrenceRule["frequency"]) ?? "weekly",
    interval: item.recurrence_interval ?? 1,
    weekdays: item.recurrence_weekdays ?? [],
    monthlyMode: (item.recurrence_monthly_mode as RecurrenceRule["monthlyMode"]) ?? "day_of_month",
    monthlyDay: item.recurrence_monthly_day ?? 1,
    monthlyWeekN: item.recurrence_monthly_week_n ?? 1,
    monthlyWeekday: item.recurrence_monthly_weekday ?? 1,
    endMode: (item.recurrence_end_mode as RecurrenceRule["endMode"]) ?? "never",
    endDate: item.recurrence_end_date ?? null,
    count: item.recurrence_count ?? null,
  };
}

export interface RecurrenceRule {
  enabled: boolean;
  frequency: "daily" | "weekly" | "monthly";
  interval: number;
  weekdays: number[];
  monthlyMode: "day_of_month" | "weekday_of_month";
  monthlyDay: number;
  monthlyWeekN: number;
  monthlyWeekday: number;
  endMode: "never" | "on_date" | "after_count";
  endDate: string | null;
  count: number | null;
}

export function parseRecurrenceFromTask(task: Task): RecurrenceRule {
  return parseRecurrenceFromItem(task);
}

export function formatLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function findNthWeekdayOfMonth(year: number, month: number, n: number, weekday: number): Date | null {
  if (n === -1) {
    const lastDay = new Date(year, month + 1, 0).getDate();
    const lastDate = new Date(year, month, lastDay);
    const lastWeekday = lastDate.getDay();
    const diff = (lastWeekday - weekday + 7) % 7;
    return new Date(year, month, lastDay - diff);
  }
  const firstWeekday = new Date(year, month, 1).getDay();
  const diff = (weekday - firstWeekday + 7) % 7;
  const day = 1 + diff + (n - 1) * 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  if (day > daysInMonth) return null;
  return new Date(year, month, day);
}

function getMondayOfWeek(d: Date): Date {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

export function expandRecurrence(
  rule: RecurrenceRule,
  startDate: Date,
  rangeStart: Date,
  rangeEnd: Date,
): Date[] {
  if (!rule.enabled) return [];

  const result: Date[] = [];
  let count = 0;
  const maxCount = rule.endMode === "after_count" ? (rule.count ?? 0) : Infinity;
  const maxDate = rule.endMode === "on_date" && rule.endDate ? new Date(rule.endDate) : null;
  const MAX_ITERATIONS = 10000;
  let iterations = 0;

  const startDay = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());

  if (rule.frequency === "daily") {
    let cur = new Date(startDay);
    while (count < maxCount && iterations < MAX_ITERATIONS) {
      if (maxDate && cur > maxDate) break;
      if (cur >= rangeEnd) break;
      count++;
      if (cur >= rangeStart && cur < rangeEnd) result.push(new Date(cur));
      // Step by calendar days, not 24h blocks, so daylight-saving changes
      // don't duplicate or shift a day.
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + rule.interval);
      iterations++;
    }
  } else if (rule.frequency === "weekly") {
    const startMonday = getMondayOfWeek(startDay);
    // Weeks run Monday→Sunday, so order weekdays that way (Sunday last);
    // otherwise Sunday is counted before Mon–Sat of the same week, which
    // breaks "ends after N occurrences" and returns dates out of order.
    const mondayFirst = (d: number) => (d + 6) % 7;
    const weekdays = rule.weekdays.length > 0
      ? [...rule.weekdays].sort((a, b) => mondayFirst(a) - mondayFirst(b))
      : [startDay.getDay()];
    let weekNum = 0;
    let stopped = false;
    while (!stopped && count < maxCount && iterations < MAX_ITERATIONS) {
      const weekMonday = new Date(startMonday);
      weekMonday.setDate(startMonday.getDate() + weekNum * rule.interval * 7);
      if (maxDate && weekMonday > maxDate) break;
      if (weekMonday >= rangeEnd) break;
      for (const wd of weekdays) {
        const daysFromMonday = (wd - 1 + 7) % 7;
        const occDay = new Date(weekMonday);
        occDay.setDate(weekMonday.getDate() + daysFromMonday);
        if (occDay < startDay) continue;
        if (maxDate && occDay > maxDate) { stopped = true; break; }
        count++;
        if (count > maxCount) { stopped = true; break; }
        if (occDay >= rangeStart && occDay < rangeEnd) result.push(new Date(occDay));
      }
      weekNum++;
      iterations++;
    }
  } else if (rule.frequency === "monthly") {
    let monthNum = 0;
    while (count < maxCount && iterations < MAX_ITERATIONS) {
      const totalMonths = startDay.getMonth() + monthNum * rule.interval;
      const year = startDay.getFullYear() + Math.floor(totalMonths / 12);
      const month = ((totalMonths % 12) + 12) % 12;
      let occDay: Date | null = null;
      if (rule.monthlyMode === "day_of_month") {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        if (rule.monthlyDay <= daysInMonth) {
          occDay = new Date(year, month, rule.monthlyDay);
        }
      } else {
        occDay = findNthWeekdayOfMonth(year, month, rule.monthlyWeekN, rule.monthlyWeekday);
      }
      if (occDay && occDay >= startDay) {
        if (maxDate && occDay > maxDate) break;
        count++;
        if (occDay >= rangeStart && occDay < rangeEnd) result.push(new Date(occDay));
        if (occDay >= rangeEnd) break;
      }
      monthNum++;
      iterations++;
    }
  }

  return result;
}

const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const NTH_FULL: Record<number, string> = { 1: "First", 2: "Second", 3: "Third", 4: "Fourth", [-1]: "Last" };

export function formatRecurrenceSummary(rule: RecurrenceRule): string {
  if (!rule.enabled) return "";
  const intervalWord = rule.interval === 1 ? "" : `${rule.interval} `;
  if (rule.frequency === "daily") {
    return rule.interval === 1 ? "Daily" : `Every ${rule.interval} days`;
  }
  if (rule.frequency === "weekly") {
    const base = rule.interval === 1 ? "Weekly" : `Every ${rule.interval} weeks`;
    if (rule.weekdays.length === 0) return base;
    const days = [...rule.weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_FULL[d]);
    if (days.length === 1) return `${base} on ${days[0]}`;
    if (days.length === 2) return `${base} on ${days[0]} and ${days[1]}`;
    return `${base} on ${days.slice(0, -1).join(", ")}, and ${days[days.length - 1]}`;
  }
  if (rule.frequency === "monthly") {
    const base = rule.interval === 1 ? "Monthly" : `Every ${rule.interval} months`;
    if (rule.monthlyMode === "day_of_month") {
      const suffix = rule.monthlyDay === 1 ? "1st" : rule.monthlyDay === 2 ? "2nd" : rule.monthlyDay === 3 ? "3rd" : `${rule.monthlyDay}th`;
      return `${base} on the ${suffix}`;
    }
    const nth = NTH_FULL[rule.monthlyWeekN] ?? "First";
    const wd = WEEKDAY_FULL[rule.monthlyWeekday] ?? "Monday";
    return `${base} on the ${nth} ${wd}`;
  }
  return "";
}
