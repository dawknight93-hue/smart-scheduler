/**
 * Loads this copy's saved settings (app_settings table, one row) after start-up.
 * With no table or no row, the defaults stay — which is the original setup.
 */
import { supabase } from "./supabase";
import { PILLAR_LABELS } from "./types";
import { appSettings, BOOT_KEYS, DEFAULT_SETTINGS, mergeSettings, writeCache, type AppSettings } from "./appSettings";

const BUILT_IN_LABELS = { ...PILLAR_LABELS };

/** Applies role names everywhere PILLAR_LABELS is read. */
function applyRoleLabels(s: AppSettings) {
  Object.assign(PILLAR_LABELS, BUILT_IN_LABELS, s.roleLabels);
}
applyRoleLabels(appSettings);

export const SETTINGS_EVENT = "app-settings-changed";

/**
 * Reads the saved row and updates the live settings. Returns true when something
 * changed. A change to a start-up setting (time zone, airport, quiet hours) reloads.
 */
export async function loadAppSettings(): Promise<boolean> {
  const { data, error } = await supabase.from("app_settings").select("settings").eq("id", 1).maybeSingle();
  if (error || !data) return false; // no table / no row yet: keep the defaults
  const next = mergeSettings(DEFAULT_SETTINGS, (data as { settings: Partial<AppSettings> }).settings);
  const before = JSON.stringify(appSettings);
  if (JSON.stringify(next) === before) return false;
  const needsReload = BOOT_KEYS.some((k) => JSON.stringify(next[k]) !== JSON.stringify(appSettings[k]));
  writeCache(next);
  if (needsReload) {
    window.location.reload();
    return true;
  }
  Object.assign(appSettings, next);
  applyRoleLabels(appSettings);
  window.dispatchEvent(new Event(SETTINGS_EVENT));
  return true;
}

/** Saves settings (used by the setup and settings screens). */
export async function saveAppSettings(patch: Partial<AppSettings>): Promise<void> {
  const next = mergeSettings(appSettings, patch);
  const { error } = await supabase.from("app_settings").upsert({ id: 1, settings: next, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  await loadAppSettings();
}
