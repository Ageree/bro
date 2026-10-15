import type { DynamicResolveContext } from "eve";
import { z } from "zod";
import { skillsLayout } from "@agent/lib/skills/pilot";
import type { TurnKind } from "@agent/lib/turn-kind/kind";
import { env } from "@shared/environment";
import { directModelActive } from "@shared/model/provider";

/** What the pilot reads of a turn: who is calling. */
interface RouterContext {
  readonly session: {
    readonly auth: DynamicResolveContext["session"]["auth"];
  };
}

/** Whether TOOL_ROUTER_WORKSPACES names a workspace, by id or `*`. */
export function toolRouterListedWorkspace(workspaceId: string) {
  const list = env.TOOL_ROUTER_WORKSPACES ?? [];
  return list.includes("*") || list.includes(workspaceId);
}

/**
 * Whether the workspace of this turn is in the pilot of the tool router
 * (TOOL_ROUTER_WORKSPACES, workspace ids or `*`): a pure read of the
 * environment, as `skillsPilot`, so a tool's resolver asks it at every step
 * of every workspace without a lookup. Only the direct model holds a step to
 * a set of tools; on the Gateway nobody is in it.
 */
export function toolRouterListed(context: RouterContext) {
  if ((env.TOOL_ROUTER_WORKSPACES ?? []).length === 0) return false;
  if (!directModelActive()) return false;
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  if (caller?.principalType !== "user") return false;
  const workspaceId = z
    .string()
    .min(1)
    .safeParse(caller.attributes.workspaceId).data;
  return workspaceId !== undefined && toolRouterListedWorkspace(workspaceId);
}

/**
 * `shadow`: the router decides and logs, and every tool stays; `on`: a
 * person's step sees the core and the chosen groups. Only the environment
 * switches it.
 */
export function toolRouterMode() {
  return env.TOOL_ROUTER_MODE;
}

/**
 * Whether the router chooses this turn's tools: a person's turn in the
 * pilot, read with the core instructions of the skills pilot, whose short
 * descriptions and `load_skill` the groups lean on. The pilot of the
 * cache-friendly step is the caller's to check (`stepContextPilot`): without
 * it the tool block changes between steps anyway.
 */
export function toolRouterEligible(context: RouterContext, kind: TurnKind) {
  return (
    toolRouterListed(context) &&
    kind === "person" &&
    skillsLayout(context) === "core"
  );
}
