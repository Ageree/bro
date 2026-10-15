import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { phonePilot } from "@db/services/phone";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { taskAgentPilot } from "@agent/lib/sandbox/pilot";
import { skillsLayout } from "@agent/lib/skills/pilot";
import { stepContextPilotOfCaller } from "@agent/lib/step-context/pilot";
import { toolRouterListed, toolRouterMode } from "@agent/lib/tool-router/pilot";
import {
  type RouterGroup,
  routerGroupIndex,
  routerGroups,
} from "@agent/lib/tool-router/questions";
import {
  stepIdentity,
  stepStartedEventSchema,
} from "@agent/lib/turn-kind/step";

/**
 * The way out of the tool router (`TOOL_ROUTER_MODE=on`): a person's step
 * sees the core tools and the groups the router chose, and a request the
 * router missed opens its group here instead of ending in «не могу». The
 * description lists the workspace's groups and stays the same for it, so it
 * stays in the cached prefix; the model resolver reads the calls of the
 * turn and adds their groups from the next step
 * (`agent/lib/tool-router/turn.ts`). A group whose tools this workspace
 * never has — `files` outside the task agent's pilot, `phone` outside the
 * phone's — is not offered: opening it would promise tools that never come.
 */
function openToolsOf(offered: readonly [RouterGroup, ...RouterGroup[]]) {
  return defineTool({
    description: `Your tools this turn are the core ones plus the groups the request needs. If the request needs a tool you do not see, or a skill block above names a tool missing from your list, open its group here before you say you cannot; its tools are yours from the next step. Groups: ${offered.map((group) => `${group} (${routerGroupIndex[group]})`).join("; ")}.`,
    inputSchema: z.object({
      groups: z.array(z.enum(offered)).min(1).max(4),
    }),
    execute: ({ groups }) => ({
      note: "Their tools are in your list from the next step; call them there.",
      opened: groups,
    }),
  });
}

export default defineDynamic({
  events: {
    "step.started": async (event, context) => {
      // The environment first: every workspace's step asks, and only the
      // pilot's may look anything up.
      if (!toolRouterListed(context) || toolRouterMode() !== "on") {
        return null;
      }
      if (resolveModeValue(context, { interactive: true }) !== true) {
        return null;
      }
      if (skillsLayout(context) !== "core") return null;
      const started = stepStartedEventSchema.safeParse(event).data;
      if (!(await stepContextPilotOfCaller(context, started))) {
        return null;
      }
      const caller = context.session.auth.current;
      if (caller?.principalType !== "user") return null;
      const scope = scopeFromPrincipal(caller);
      const files = await taskAgentPilot(
        scope,
        stepIdentity(started, context.session.id)
      );
      const phone = phonePilot(scope);
      const [first, ...rest] = routerGroups.filter(
        (group) => (group !== "files" || files) && (group !== "phone" || phone)
      );
      return first === undefined ? null : openToolsOf([first, ...rest]);
    },
  },
});
