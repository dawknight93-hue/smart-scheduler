/**
 * Which release of the app this is, and which database layout it expects.
 *
 * Every copy builds from the same GitHub code, so two copies showing the same
 * APP_VERSION run the same code. SCHEMA_VERSION is the last database change
 * this code needs: each new migration ends with
 *   UPDATE schema_meta SET version = <its timestamp> WHERE id = 1;
 * and SCHEMA_VERSION here is bumped to match. A copy whose database is behind
 * shows a banner instead of quietly misbehaving.
 */
import { supabase } from "./supabase";

export const APP_VERSION = "2026.10.10-2";
export const SCHEMA_VERSION = 20261010120000;

/** The database's layout version, or 0 when it predates the check. */
export async function databaseVersion(): Promise<number> {
  const { data, error } = await supabase.from("schema_meta").select("version").eq("id", 1).maybeSingle();
  if (error || !data) return 0;
  return Number((data as { version: number }).version) || 0;
}
