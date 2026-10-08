/**
 * Miami time everywhere.
 *
 * The scheduler plans in its home time zone (America/New_York) so every device
 * produces the same plan and the same Google Calendar. The screens, though, use
 * the browser's local clock — so on a computer or phone set to another time zone
 * (Mountain, a trip, a mis-set PC) a 06:00 Miami slot showed as 04:00 and the
 * week grid's dates slid a day.
 *
 * When the device isn't on Miami time, this swaps in a Date whose "local" clock
 * IS Miami time: getHours / getDate / setHours / new Date(y, m, d, h) /
 * "2026-10-08T09:00" strings / toLocale…String all read and write Miami
 * wall-clock time, while instants (getTime, toISOString, what's saved) are
 * untouched. On a device already on Miami time nothing is replaced.
 *
 * Imported first in main.tsx, before anything else creates a Date.
 */

export const HOME_ZONE = "America/New_York";

const Real = Date;
const deviceZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
})();

const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: HOME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

const STEP = 15 * 60000;
const cache = new Map<number, number>();
/** Miami's offset from UTC at instant t, in ms (e.g. −4 h in summer). */
function offsetMs(t: number): number {
  const k = Math.floor(t / STEP);
  let v = cache.get(k);
  if (v === undefined) {
    const at = k * STEP;
    const p = Object.fromEntries(fmt.formatToParts(new Real(at)).map((x) => [x.type, x.value]));
    v = Real.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - at;
    if (cache.size > 5000) cache.clear();
    cache.set(k, v);
  }
  return v;
}

/** The instant at a Miami wall-clock time (fields may overflow, like Date's). */
export function homeInstant(y: number, mo: number, d = 1, h = 0, mi = 0, s = 0, ms = 0): number {
  const guess = Real.UTC(y, mo, d, h, mi, s, ms);
  let t = guess - offsetMs(guess);
  t = guess - offsetMs(t); // settle across a DST change
  return t;
}

const deviceDiffers = (() => {
  if (!deviceZone || deviceZone === HOME_ZONE) return false;
  // Same rules under another name (e.g. America/Detroit) need nothing either.
  const probes = [Real.UTC(2026, 0, 15, 12), Real.UTC(2026, 6, 15, 12), Real.now()];
  return probes.some((t) => new Real(t).getTimezoneOffset() !== -offsetMs(t) / 60000);
})();

/** True when this device isn't on Miami time and the app is showing Miami time anyway. */
export const homeClockActive = deviceDiffers;
/** The device's own time zone name, for the notice. */
export const deviceTimeZone = deviceZone;

if (deviceDiffers) install();

function install() {
  const LOCAL_ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
  const parse = (s: string): number => {
    const m = LOCAL_ISO.exec(s.trim());
    if (!m) return Real.parse(s);
    return homeInstant(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0), +(m[7] ?? "0").padEnd(3, "0"));
  };

  function HomeDate(this: unknown, ...a: unknown[]): unknown {
    if (!new.target) return new (HomeDate as unknown as DateConstructor)().toString();
    let t: number;
    if (a.length === 0) t = Real.now();
    else if (a.length === 1) {
      const v = a[0];
      t = typeof v === "string" ? parse(v) : v instanceof Real ? v.getTime() : Number(v);
    } else {
      const n = a.map(Number);
      t = homeInstant(n[0], n[1], n[2] ?? 1, n[3] ?? 0, n[4] ?? 0, n[5] ?? 0, n[6] ?? 0);
    }
    return Reflect.construct(Real, [t], new.target);
  }

  const proto = Object.create(Real.prototype);
  HomeDate.prototype = proto;
  Object.setPrototypeOf(HomeDate, Real); // statics: UTC, now…
  (HomeDate as unknown as { parse: (s: string) => number }).parse = parse;
  (HomeDate as unknown as { now: () => number }).now = Real.now;

  // Miami wall clock of this instant, read with the UTC getters.
  const wall = (d: Date) => {
    const t = Real.prototype.getTime.call(d);
    return new Real(t + offsetMs(t));
  };
  const set = (d: Date, t: number) => Real.prototype.setTime.call(d, t);

  Object.assign(proto, {
    constructor: HomeDate,
    getFullYear(this: Date) { return wall(this).getUTCFullYear(); },
    getMonth(this: Date) { return wall(this).getUTCMonth(); },
    getDate(this: Date) { return wall(this).getUTCDate(); },
    getDay(this: Date) { return wall(this).getUTCDay(); },
    getHours(this: Date) { return wall(this).getUTCHours(); },
    getMinutes(this: Date) { return wall(this).getUTCMinutes(); },
    getSeconds(this: Date) { return wall(this).getUTCSeconds(); },
    getMilliseconds(this: Date) { return wall(this).getUTCMilliseconds(); },
    getTimezoneOffset(this: Date) { return -offsetMs(Real.prototype.getTime.call(this)) / 60000; },
    setFullYear(this: Date, y: number, mo?: number, d?: number) {
      const w = wall(this);
      return set(this, homeInstant(y, mo ?? w.getUTCMonth(), d ?? w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds(), w.getUTCMilliseconds()));
    },
    setMonth(this: Date, mo: number, d?: number) {
      const w = wall(this);
      return set(this, homeInstant(w.getUTCFullYear(), mo, d ?? w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds(), w.getUTCMilliseconds()));
    },
    setDate(this: Date, d: number) {
      const w = wall(this);
      return set(this, homeInstant(w.getUTCFullYear(), w.getUTCMonth(), d, w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds(), w.getUTCMilliseconds()));
    },
    setHours(this: Date, h: number, mi?: number, s?: number, ms?: number) {
      const w = wall(this);
      return set(this, homeInstant(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), h, mi ?? w.getUTCMinutes(), s ?? w.getUTCSeconds(), ms ?? w.getUTCMilliseconds()));
    },
    setMinutes(this: Date, mi: number, s?: number, ms?: number) {
      const w = wall(this);
      return set(this, homeInstant(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), mi, s ?? w.getUTCSeconds(), ms ?? w.getUTCMilliseconds()));
    },
    setSeconds(this: Date, s: number, ms?: number) {
      const w = wall(this);
      return set(this, homeInstant(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), s, ms ?? w.getUTCMilliseconds()));
    },
    setMilliseconds(this: Date, ms: number) {
      const w = wall(this);
      return set(this, homeInstant(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds(), ms));
    },
    toLocaleString(this: Date, l?: string | string[], o?: Intl.DateTimeFormatOptions) {
      return Real.prototype.toLocaleString.call(this, l, { timeZone: HOME_ZONE, ...(o ?? {}) });
    },
    toLocaleDateString(this: Date, l?: string | string[], o?: Intl.DateTimeFormatOptions) {
      return Real.prototype.toLocaleDateString.call(this, l, { timeZone: HOME_ZONE, ...(o ?? {}) });
    },
    toLocaleTimeString(this: Date, l?: string | string[], o?: Intl.DateTimeFormatOptions) {
      return Real.prototype.toLocaleTimeString.call(this, l, { timeZone: HOME_ZONE, ...(o ?? {}) });
    },
    toDateString(this: Date) {
      return Real.prototype.toLocaleDateString.call(this, "en-US", { timeZone: HOME_ZONE, weekday: "short", month: "short", day: "2-digit", year: "numeric" }).replace(/,/g, "");
    },
    toTimeString(this: Date) {
      const off = offsetMs(Real.prototype.getTime.call(this)) / 60000; // e.g. −240
      const sign = off < 0 ? "-" : "+";
      const a = Math.abs(off);
      const hh = String(Math.floor(a / 60)).padStart(2, "0");
      const mm = String(a % 60).padStart(2, "0");
      const w = wall(this);
      const p2 = (n: number) => String(n).padStart(2, "0");
      return `${p2(w.getUTCHours())}:${p2(w.getUTCMinutes())}:${p2(w.getUTCSeconds())} GMT${sign}${hh}${mm} (Miami time)`;
    },
    toString(this: Date) {
      return `${(proto as Date).toDateString.call(this)} ${(proto as Date).toTimeString.call(this)}`;
    },
  });

  (globalThis as unknown as { Date: unknown }).Date = HomeDate;
}
