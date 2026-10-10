import { env } from "@shared/environment";

/**
 * False on a deployment with `EVE_SCHEDULES=off` or `browser`: a rehearsal
 * stand runs every schedule's tick but must do nothing in it. Not eve's
 * `TEST=1`: Better Auth reads it too and turns its origin check off, so every
 * schedule checks this first instead.
 */
export function schedulesEnabled() {
  return env.EVE_SCHEDULES === "on";
}

/**
 * The browser errands' tick (`agent/schedules/browser-runs.ts`) also runs
 * with `EVE_SCHEDULES=browser`: a stand starts its queued errands and looks
 * after its pool, while every other schedule stays off.
 */
export function browserRunsEnabled() {
  return env.EVE_SCHEDULES === "on" || env.EVE_SCHEDULES === "browser";
}
