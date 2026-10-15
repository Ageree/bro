import { defineState } from "eve/context";
import { z } from "zod";
import { type RouterGroup, routerGroups } from "./questions";

/**
 * What the tool router keeps of a session in eve's durable state: it
 * outlives a restart of eve and a step on another instance. Only groups,
 * digests and times, never the text of a message: forgetting and
 * `agent/lib/conversation/erase.ts` never clean it.
 *
 * - `turnId`, `turnGroups`: the turn whose set this is, and its set, which
 *   only grows within the turn.
 * - `turnDigest`: the digest of the state string the turn was decided by;
 *   a new turn with the same one (an approval's answer, a retried first
 *   step) keeps the set without asking again.
 * - `carried`: the set of the last turn whose decision went through, the
 *   base of the next turn within the warm window.
 * - `failedOpen`: `turnGroups` is every group because the decision failed.
 * - `lastStepAt`: the last step with the router's block, which the warm
 *   window counts from.
 * - `usedAt`: the last call of a tool of each group, in any kind of turn.
 * - `called`: the groups of the tools the turn of `turnId` called so far,
 *   which the next turn logs against `turnGroups`; null once logged.
 */
const routerStateSchema = z.object({
  called: z.array(z.enum(routerGroups)).nullable().catch(null),
  carried: z.array(z.enum(routerGroups)).catch([]),
  failedOpen: z.boolean().catch(false),
  lastStepAt: z.string().nullable().catch(null),
  turnDigest: z.string().nullable().catch(null),
  turnGroups: z.array(z.enum(routerGroups)).nullable().catch(null),
  turnId: z.string().nullable().catch(null),
  usedAt: z.partialRecord(z.enum(routerGroups), z.string()).catch({}),
});

export type RouterState = z.infer<typeof routerStateSchema>;

export const emptyRouterState: RouterState = {
  called: null,
  carried: [],
  failedOpen: false,
  lastStepAt: null,
  turnDigest: null,
  turnGroups: null,
  turnId: null,
  usedAt: {},
};

const routerState = defineState<RouterState>(
  "bro.tool-router",
  () => emptyRouterState
);

/** The session's state, or the empty one where it cannot be read. */
export function readRouterState(): RouterState {
  try {
    return (
      routerStateSchema.safeParse(routerState.get()).data ?? emptyRouterState
    );
  } catch {
    // Outside eve's context: a test, the measurement script.
    return emptyRouterState;
  }
}

/** Writes the state; a failed write loses only this step's record. */
export function writeRouterState(next: RouterState) {
  try {
    routerState.update(() => next);
  } catch (error) {
    console.warn("[tool-router] state not written", {
      cause: error instanceof Error ? error.name : "unknown",
    });
  }
}

/** The groups in their order, each once. */
export function orderedGroups(groups: Iterable<RouterGroup>): RouterGroup[] {
  const set = new Set(groups);
  return routerGroups.filter((group) => set.has(group));
}
