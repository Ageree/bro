import { env } from "@shared/environment";

/**
 * False on a deployment with `SCHEDULES=off`: the Cloud.ru rehearsal stand
 * runs every schedule's tick but must do nothing in it. eve's own switch,
 * `TEST=1`, also stops the scheduler, but a stray env file could drop it;
 * every schedule checks this first instead.
 */
export function schedulesEnabled() {
  return env.SCHEDULES === "on";
}
