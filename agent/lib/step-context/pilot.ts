import {
  listsWorkspaceRemembered,
  pilotVerdictOfTurn,
} from "@agent/lib/workspace-list";
import type { DynamicResolveContext } from "eve";
import type { SessionContext } from "eve/context";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { stepIdentity } from "@agent/lib/turn-kind/step";
import { env } from "@shared/environment";
import { directModelActive } from "@shared/model/provider";

/**
 * Whether a workspace's steps are built for the prompt cache
 * (docs/agent-costs.md, 3.2): the notes of a step — the person's clock, the
 * reply directive and the rest — come after the history rather than in the
 * system part, and a browser report's turn keeps only its few tools once its
 * message is out. STEP_CONTEXT_WORKSPACES names the pilot by workspace id or
 * owner's email, as BROWSER_VM_WORKSPACES does, or everyone with `*`.
 *
 * Only the direct model (RouterAI or OpenRouter) carries step notes: a Gateway id would
 * lose the clock along with them, so there nobody is in the pilot. A failed
 * lookup of the email keeps the workspace out of the pilot for that call
 * rather than failing the step, and is not remembered. Asked with the step's
 * `turn` (`stepIdentity`), the verdict holds for the whole turn, and a
 * failed lookup keeps the session's last one: one flip between steps changed
 * the step's notes and tools and broke the turn's prompt cache.
 */
export async function stepContextPilot(
  scope: {
    readonly userId?: string;
    readonly workspaceId: string;
  },
  turn?: Parameters<typeof pilotVerdictOfTurn>[1]
) {
  const list = env.STEP_CONTEXT_WORKSPACES ?? [];
  if (!directModelActive() || list.length === 0) return false;
  if (list.includes("*")) return true;
  return pilotVerdictOfTurn("step-context", turn, async () => {
    try {
      // Every step asks, and the turn's instructions ask once more.
      return await listsWorkspaceRemembered(list, scope);
    } catch (error) {
      console.warn("[step-context] pilot lookup failed", { cause: error });
      return undefined;
    }
  });
}

/** `stepContextPilot` of the session's caller, for the turn `turn`. */
async function callerPilot(
  session: Pick<DynamicResolveContext["session"], "auth">,
  turn: Parameters<typeof pilotVerdictOfTurn>[1]
) {
  const caller = session.auth.current ?? session.auth.initiator;
  if (caller?.principalType !== "user") return false;
  // A resolver that throws loses all its tools for the step.
  let scope: ReturnType<typeof scopeFromPrincipal>;
  try {
    scope = scopeFromPrincipal(caller);
  } catch {
    return false;
  }
  return stepContextPilot(scope, turn);
}

/**
 * `stepContextPilot` for a tool's `step.started` resolver: the caller's
 * workspace, the verdict of the turn the model's resolver got too.
 */
export async function stepContextPilotOfCaller(
  context: Pick<DynamicResolveContext, "session">,
  event: Parameters<typeof stepIdentity>[0]
) {
  return callerPilot(context.session, stepIdentity(event, context.session.id));
}

/**
 * `stepContextPilot` for a tool's approval or execute, with the same
 * verdict of the turn: eve's `session.turn.id` is the `turnId` of the
 * turn's `step.started`.
 */
export async function stepContextPilotOfTool(
  session: Pick<SessionContext["session"], "auth" | "id" | "turn">
) {
  return callerPilot(session, {
    sessionId: session.id,
    turnId: session.turn.id,
  });
}
