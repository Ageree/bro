import { env } from "@shared/environment";

/**
 * False on a deployment with `EVE_SCHEDULES=off`: the Cloud.ru rehearsal stand
 * runs every schedule's tick but must do nothing in it. Not eve's `TEST=1`:
 * Better Auth reads it too and turns its origin check off, so every schedule
 * checks this first instead.
 */
export function schedulesEnabled() {
  return env.EVE_SCHEDULES === "on";
}
