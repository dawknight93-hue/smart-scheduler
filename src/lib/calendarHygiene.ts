import type { FixedEvent } from "./types";
import { supabase } from "./supabase";

/**
 * Calendar Hygiene: keeping goal tasks off travel and duty time.
 * See "Goal Planner Flight Manual" Section 04 for the full design spec.
 */

/** The pilot's home base. Drive-time (Enroute) blocks only ever touch this airport. */
export const HOME_AIRPORT = "MIA";

/**
 * Minimum ground time, on the home-airport side of a gap between two legs,
 * for that gap to count as a real trip boundary rather than an interior
 * stop on the same trip. Set off the FAA's 10-hour minimum crew rest --
 * anything shorter isn't enough time to actually go home and back.
 */
export const BOUNDARY_GAP_HOURS = 8;
const BOUNDARY_GAP_MS = BOUNDARY_GAP_HOURS * 60 * 60 * 1000;

/** Matches the crew-schedule export's flight title format, e.g. "MIA→BNA • AA 1226". */
const FLIGHT_NAME_PATTERN = /([A-Z]{3})\u200b?\u2192\u200b?([A-Z]{3})\s*\u2022/;

export interface FlightLeg {
  event: FixedEvent;
  origin: string;
  destination: string;
}

/** Parses a fixed_events row into a FlightLeg if its name matches the flight title format, else null. */
export function parseFlightLeg(event: FixedEvent): FlightLeg | null {
  const match = FLIGHT_NAME_PATTERN.exec(event.name);
  if (!match) return null;
  return { event, origin: match[1], destination: match[2] };
}

export interface Trip {
  legs: FlightLeg[];
}

/**
 * True when the gap between two consecutive legs is a real trip boundary:
 * it touches the home airport on either side of the gap (the earlier leg
 * lands there, or the later leg departs from there), and that ground time
 * is at least BOUNDARY_GAP_HOURS. A gap that never touches home is not
 * evaluated and is never a boundary, no matter how long it runs -- e.g. an
 * overnight layover away from base stays interior to the same trip.
 */
export function isTripBoundary(prev: FlightLeg, next: FlightLeg): boolean {
  const touchesHome = prev.destination === HOME_AIRPORT || next.origin === HOME_AIRPORT;
  if (!touchesHome) return false;

  const gapMs = new Date(next.event.start_time).getTime() - new Date(prev.event.end_time).getTime();
  return gapMs >= BOUNDARY_GAP_MS;
}

/**
 * Groups a list of fixed events into trips. A trip is a run of flight legs,
 * sorted by start time, connected by gaps that never amount to a real trip
 * boundary (see isTripBoundary). Non-flight events are ignored.
 */
export function groupFlightsIntoTrips(events: FixedEvent[]): Trip[] {
  const legs = events
    .map(parseFlightLeg)
    .filter((leg): leg is FlightLeg => leg !== null)
    .sort((a, b) => new Date(a.event.start_time).getTime() - new Date(b.event.start_time).getTime());

  const trips: Trip[] = [];
  let current: FlightLeg[] = [];

  for (const leg of legs) {
    if (current.length === 0) {
      current.push(leg);
      continue;
    }
    const prev = current[current.length - 1];
    if (isTripBoundary(prev, leg)) {
      trips.push({ legs: current });
      current = [leg];
    } else {
      current.push(leg);
    }
  }
  if (current.length > 0) trips.push({ legs: current });

  return trips;
}


export interface EnrouteNeed {
  direction: "to" | "from";
  flight: FixedEvent;
  boundaryTime: Date;
}

/**
 * Which ends of a trip touch home and need an Enroute block: an
 * Enroute-to before the first leg if it originates at MIA, and/or an
 * Enroute-home after the last leg if it lands at MIA. A trip that starts
 * or ends away from base (mid-trip data, or a partial month) simply
 * has no need on that end.
 */
export function tripEnrouteNeeds(trip: Trip): EnrouteNeed[] {
  const needs: EnrouteNeed[] = [];
  const first = trip.legs[0];
  const last = trip.legs[trip.legs.length - 1];

  if (first.origin === HOME_AIRPORT) {
    needs.push({ direction: "to", flight: first.event, boundaryTime: new Date(first.event.start_time) });
  }
  if (last.destination === HOME_AIRPORT) {
    needs.push({ direction: "from", flight: last.event, boundaryTime: new Date(last.event.end_time) });
  }
  return needs;
}


/**
 * Fallback timing constants until a live duration/traffic source is wired in --
 * mirror the "When do I leave?" tool's own breakdown so both tools agree.
 * "To": leave home -> drive -> park -> walk to terminal -> at gate (a buffer
 * before departure). "From": touchdown -> walk to car -> drive home.
 */
export const DEFAULT_DRIVE_MINUTES = 60;
export const DEFAULT_PARKING_MINUTES = 15;
export const DEFAULT_TERMINAL_TO_MINUTES = 30;
export const DEFAULT_GATE_BUFFER_MINUTES = 45;
export const DEFAULT_TERMINAL_FROM_MINUTES = 45;

export interface EnrouteBlockPlan {
  direction: "to" | "from";
  flight: FixedEvent;
  start: Date;
  end: Date;
  durationMin: number;
}

/**
 * Turns an EnrouteNeed into concrete start/end times for the block.
 * An Enroute-to block ends DEFAULT_GATE_BUFFER_MINUTES before the flight's own
 * departure time (not at departure itself), and starts drive+parking+terminal
 * minutes before that gate cutoff. An Enroute-home block starts at the
 * boundary (touchdown) and ends terminal-walk+drive minutes later.
 * driveMin overrides only the drive-time leg, so a live-traffic source can be
 * dropped in later without touching the fixed parking/terminal/gate buffers.
 */
export function planEnrouteBlock(need: EnrouteNeed, driveMin: number = DEFAULT_DRIVE_MINUTES): EnrouteBlockPlan {
  if (need.direction === "to") {
    const leadMin = driveMin + DEFAULT_PARKING_MINUTES + DEFAULT_TERMINAL_TO_MINUTES;
    const end = new Date(need.boundaryTime.getTime() - DEFAULT_GATE_BUFFER_MINUTES * 60 * 1000);
    const start = new Date(end.getTime() - leadMin * 60 * 1000);
    return { direction: need.direction, flight: need.flight, start, end, durationMin: leadMin + DEFAULT_GATE_BUFFER_MINUTES };
  }
  const leadMin = DEFAULT_TERMINAL_FROM_MINUTES + driveMin;
  const start = need.boundaryTime;
  const end = new Date(start.getTime() + leadMin * 60 * 1000);
  return { direction: need.direction, flight: need.flight, start, end, durationMin: leadMin };
}

/** Plans every Enroute block a trip needs, in order (to-block first if present, then home-block). */
export function planTripEnrouteBlocks(trip: Trip, driveMin: number = DEFAULT_DRIVE_MINUTES): EnrouteBlockPlan[] {
  return tripEnrouteNeeds(trip).map((need) => planEnrouteBlock(need, driveMin));
}


export interface StoredEnrouteBlock {
  id: string;
  flight_id: string;
  name: string;
  direction: "to" | "from";
  start_time: string;
  end_time: string;
  drive_duration_min: number;
}

export interface OverrideKey {
  flight_id: string;
  direction: "to" | "from";
}

export interface EnrouteBlockDiff {
  toCreate: EnrouteBlockPlan[];
  toUpdate: { id: string; plan: EnrouteBlockPlan }[];
  toDelete: StoredEnrouteBlock[];
}

function enrouteKey(flightId: string, direction: "to" | "from"): string {
  return `${flightId}:${direction}`;
}

/**
 * Compares what the current flight list actually needs against what's
 * already sitting in enroute_blocks, and returns the create/update/delete
 * operations to bring the table back in line -- skipping any
 * (flight, direction) that has a row in enroute_overrides, since that
 * means a human already adjusted that boundary and an automated recheck
 * should leave it alone (deleting the override is what puts it back
 * under automatic control, per Revision M).
 *
 * This one function is the whole recheck: call it after a flight is
 * deleted (its trip's boundaries may have shifted), after a flight's
 * time changes (the affected block comes back as an update, which is
 * exactly the "slide the block" behavior from Revision K/L), or from a
 * manual "Recheck flights" action -- the diff logic doesn't change,
 * only what triggers it.
 */
export function diffEnrouteBlocks(
  events: FixedEvent[],
  existingBlocks: StoredEnrouteBlock[],
  overrides: OverrideKey[]
): EnrouteBlockDiff {
  const overrideKeys = new Set(overrides.map((o) => enrouteKey(o.flight_id, o.direction)));
  const trips = groupFlightsIntoTrips(events);
  const wantedPlans = trips.flatMap((trip) => planTripEnrouteBlocks(trip));

  const existingByKey = new Map(existingBlocks.map((b) => [enrouteKey(b.flight_id, b.direction), b]));

  const toCreate: EnrouteBlockPlan[] = [];
  const toUpdate: { id: string; plan: EnrouteBlockPlan }[] = [];
  const seenKeys = new Set<string>();

  for (const plan of wantedPlans) {
    const key = enrouteKey(plan.flight.id, plan.direction);
    seenKeys.add(key);
    if (overrideKeys.has(key)) continue;

    const existing = existingByKey.get(key);
    if (!existing) {
      toCreate.push(plan);
    } else if (
      new Date(existing.start_time).getTime() !== plan.start.getTime() ||
      new Date(existing.end_time).getTime() !== plan.end.getTime() ||
      existing.drive_duration_min !== plan.durationMin
    ) {
      toUpdate.push({ id: existing.id, plan });
    }
  }

  const toDelete = existingBlocks.filter((b) => {
    const key = enrouteKey(b.flight_id, b.direction);
    return !seenKeys.has(key) && !overrideKeys.has(key);
  });

  return { toCreate, toUpdate, toDelete };
}


export interface RecheckSummary {
  created: number;
  updated: number;
  deleted: number;
}

/**
 * Applies diffEnrouteBlocks() against the live database: pulls every
 * fixed_events row (non-flight rows are simply ignored further down the
 * pipeline, by parseFlightLeg), the current enroute_blocks, and the
 * current enroute_overrides, computes the diff, and applies it --
 * inserting new blocks, updating ones whose time or duration moved, and
 * removing ones no longer needed. This is the one function a manual
 * "Recheck flights" click (step 6) and the automatic deletion/time-change
 * triggers should both call; only the moment they call it differs.
 */
export async function recheckEnrouteBlocks(): Promise<RecheckSummary> {
  const [eventsRes, blocksRes, overridesRes] = await Promise.all([
    supabase.from("fixed_events").select("*"),
    supabase.from("enroute_blocks").select("*"),
    supabase.from("enroute_overrides").select("flight_id, direction"),
  ]);

  if (eventsRes.error) throw eventsRes.error;
  if (blocksRes.error) throw blocksRes.error;
  if (overridesRes.error) throw overridesRes.error;

  const events = (eventsRes.data ?? []) as FixedEvent[];
  const existingBlocks = (blocksRes.data ?? []) as StoredEnrouteBlock[];
  const overrides = (overridesRes.data ?? []) as OverrideKey[];

  const { toCreate, toUpdate, toDelete } = diffEnrouteBlocks(events, existingBlocks, overrides);

  if (toCreate.length > 0) {
    const rows = toCreate.map((plan) => ({
      flight_id: plan.flight.id,
      name: plan.direction === "to" ? "Enroute to MIA" : "Enroute home",
      direction: plan.direction,
      start_time: plan.start.toISOString(),
      end_time: plan.end.toISOString(),
      drive_duration_min: plan.durationMin,
    }));
    const { error } = await supabase.from("enroute_blocks").insert(rows);
    if (error) throw error;
  }

  for (const { id, plan } of toUpdate) {
    const { error } = await supabase
      .from("enroute_blocks")
      .update({
        start_time: plan.start.toISOString(),
        end_time: plan.end.toISOString(),
        drive_duration_min: plan.durationMin,
      })
      .eq("id", id);
    if (error) throw error;
  }

  if (toDelete.length > 0) {
    const { error } = await supabase
      .from("enroute_blocks")
      .delete()
      .in("id", toDelete.map((b) => b.id));
    if (error) throw error;
  }

  return { created: toCreate.length, updated: toUpdate.length, deleted: toDelete.length };
}
