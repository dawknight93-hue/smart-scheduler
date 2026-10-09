/**
 * Who this copy of the app is for: home time zone and airport, quiet hours,
 * names for the life roles, and which features are switched on.
 *
 * Defaults are the original owner's setup, so an app with no saved settings
 * behaves exactly as it always has. Saved settings live in the app_settings
 * table (one row) and are cached on the device, so the very first lines of
 * code (the home clock) can read them before anything has loaded.
 *
 * This module has no imports on purpose: it's read before the clock shim and
 * the database client exist.
 */

export interface AppFeatures {
  /** Flights from a crew schedule: drive time, get ready, report time, hotel commute, trip days. */
  trips: boolean;
  /** Military drill (UTA) days keep family, desk, home and errand items off. */
  drill: boolean;
  /** Workouts from a running app's calendar (Runna) count toward goals and can't double up. */
  fitnessApp: boolean;
  /** Protect get-ready / hotel time in Google so a booking page won't sell it. */
  bookingPage: boolean;
  briefing: boolean;
  weeklyReview: boolean;
}

export interface AppSettings {
  displayName: string;
  /** IANA zone everything is planned in, e.g. "America/New_York". */
  homeTimeZone: string;
  /** How that zone is named on screen, e.g. "Miami time". */
  homeTimeLabel: string;
  /** Home airport for trips, e.g. "MIA". */
  homeAirport: string;
  /** No suggestions or drops between these hours (start > end wraps past midnight). */
  quietStartHour: number;
  quietEndHour: number;
  /** Your own names for the built-in roles, e.g. { mil_career: "Work" }. */
  roleLabels: Record<string, string>;
  features: AppFeatures;
  /** False until the first-time setup has been finished (used by the setup screens). */
  setupDone: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  displayName: "",
  homeTimeZone: "America/New_York",
  homeTimeLabel: "Miami time",
  homeAirport: "MIA",
  quietStartHour: 21,
  quietEndHour: 9,
  roleLabels: {},
  features: { trips: true, drill: true, fitnessApp: true, bookingPage: true, briefing: true, weeklyReview: true },
  setupDone: true,
};

const CACHE_KEY = "smartScheduler.appSettings";

/** Settings that are read once at start-up; changing one reloads the app. */
export const BOOT_KEYS: (keyof AppSettings)[] = ["homeTimeZone", "homeTimeLabel", "homeAirport", "quietStartHour", "quietEndHour"];

export function mergeSettings(base: AppSettings, saved: Partial<AppSettings> | null | undefined): AppSettings {
  if (!saved || typeof saved !== "object") return { ...base, features: { ...base.features }, roleLabels: { ...base.roleLabels } };
  return {
    ...base,
    ...saved,
    features: { ...base.features, ...(saved.features ?? {}) },
    roleLabels: { ...base.roleLabels, ...(saved.roleLabels ?? {}) },
  };
}

function readCache(): Partial<AppSettings> | null {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Partial<AppSettings>) : null;
  } catch {
    return null;
  }
}

export function writeCache(s: AppSettings): void {
  try {
    globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: the defaults or the next load still work */
  }
}

/** The live settings. Feature switches and labels are read from here at the moment they're needed. */
export const appSettings: AppSettings = mergeSettings(DEFAULT_SETTINGS, readCache());
