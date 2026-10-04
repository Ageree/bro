import type { DynamicResolveContext } from "eve";
import {
  listsWorkspaceRemembered,
  pilotVerdictOfTurn,
} from "@agent/lib/workspace-list";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { stepIdentity } from "@agent/lib/turn-kind/step";
import { env } from "@shared/environment";
import { directModelActive } from "@shared/model/provider";

/**
 * Whether a person's turn may open with one short heads-up — «сейчас
 * поищу», «секунду, запускаю браузер» — before slow work, instead of having
 * it sent back to be rewritten (`opensWithHeadsUp` in `turn-sends.ts`).
 * EARLY_REPLY_WORKSPACES names the pilot by workspace id or owner's email,
 * as STEP_CONTEXT_WORKSPACES does, or everyone with `*`.
 *
 * Only the direct model (RouterAI or OpenRouter) carries the step note that
 * asks for the heads-up (`earlyReplyNote`), so on the Gateway nobody is in
 * the pilot. A failed lookup of the email keeps the workspace out for that
 * call rather than failing the step. Asked with the step's `turn`, the
 * verdict holds for the whole turn: the model's resolver and `send_message`
 * must agree on it, or a heads-up the note asked for would be sent back.
 */
export async function earlyReplyPilot(
  scope: {
    readonly userId?: string;
    readonly workspaceId: string;
  },
  turn?: Parameters<typeof pilotVerdictOfTurn>[1]
) {
  const list = env.EARLY_REPLY_WORKSPACES ?? [];
  if (!directModelActive() || list.length === 0) return false;
  if (list.includes("*")) return true;
  return pilotVerdictOfTurn("early-reply", turn, async () => {
    try {
      return await listsWorkspaceRemembered(list, scope);
    } catch (error) {
      console.warn("[early-reply] pilot lookup failed", { cause: error });
      return undefined;
    }
  });
}

/**
 * `earlyReplyPilot` for a tool's `step.started` resolver: the caller's
 * workspace, the verdict of the turn the model's resolver got too. A caller
 * that is not a workspace user is out of the pilot.
 */
export async function earlyReplyPilotOfCaller(
  context: Pick<DynamicResolveContext, "session">,
  event: Parameters<typeof stepIdentity>[0]
) {
  if ((env.EARLY_REPLY_WORKSPACES ?? []).length === 0) return false;
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  if (caller?.principalType !== "user") return false;
  // A resolver that throws loses all its tools for the step.
  let scope: ReturnType<typeof scopeFromPrincipal>;
  try {
    scope = scopeFromPrincipal(caller);
  } catch {
    return false;
  }
  return earlyReplyPilot(scope, stepIdentity(event, context.session.id));
}
