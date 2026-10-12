import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { agencyActionRecorded, agencyBudgetUsage } from "@db/services/agency";
import {
  readUserProfile,
  readWorkspaceTimeZone,
} from "@db/services/user-profile";
import { resolveModeValue } from "@agent/lib/mode";
import { quietHoursEnd } from "@agent/lib/proactive/quiet-hours";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  agencyBudgetWindowMs,
  type AgencyActionClass,
  budgetRefusal,
} from "./budget";
import { disclosesHomeDetail } from "./disclosure";
import { agencyInputHash } from "./journal";
import { agencyLimited, agencyPilot } from "./pilot";

/** What the agentic worker is about to do, as its approval reads it. */
export interface AgencyDetails {
  /** The person on the other end, when the action has one. */
  readonly counterparty?: string;
  /** The person's own words for the goal, when the caller has them. */
  readonly goal?: string;
  /** The call's input as JSON text, already parsed by the tool's schema. */
  readonly input: string;
  /** The text that leaves the workspace: a letter, an invitation's text. */
  readonly text?: string;
  readonly tool: string;
}

function refused(reason: string): ApprovalStatus {
  return { reason, type: "denied" };
}

const notAgenticRun = refused(
  "Nothing was done: only the agentic worker of a pilot workspace takes this action on its own."
);

/**
 * The approval of an action the agentic worker takes on its own, or null
 * when this turn is not the agentic worker's: the caller then falls back to
 * the person's own turn (`ownTurnApproval`). `details` is read only for the
 * agentic worker, so every other turn's approval is what it was. Nothing is
 * journaled here: the action journals itself when it starts
 * (`journaledAgencyCall`), so a refusal by another guard after this grant
 * leaves no planned row behind.
 *
 * Granted, the action runs without a card. Refused: a background task's
 * turn, a workspace outside the pilot, a send or a call in the person's
 * quiet hours, a day's budget used up, an action its journal still blocks, and
 * text that gives out the person's home address or phone number.
 */
export async function agencyApproval(
  context: {
    readonly session: Pick<ApprovalContext["session"], "auth"> & {
      readonly parent?: unknown;
    };
  },
  actionClass: AgencyActionClass,
  details: () => AgencyDetails
): Promise<ApprovalStatus | null> {
  if (resolveModeValue(context, { "agentic-worker": true }) !== true) {
    return null;
  }
  const { current, initiator } = context.session.auth;
  const backgroundTask =
    current?.authenticator === "background-task" ||
    initiator?.authenticator === "background-task";
  if (backgroundTask || context.session.parent) return notAgenticRun;
  const caller = current ?? initiator;
  if (caller?.principalType !== "user") return notAgenticRun;
  const scope = scopeFromPrincipal(caller);
  if (!agencyPilot(scope.workspaceId)) return notAgenticRun;
  const action = details();

  if (actionClass === "send" || actionClass === "call") {
    const timeZone = await readWorkspaceTimeZone(scope);
    if (quietHoursEnd(new Date(), timeZone) !== undefined) {
      return refused(
        "Nothing was done: it is night for the person (quiet hours, 22:00 to 08:00 on their clock). This waits for the morning; say so in the hand-off."
      );
    }
  }

  const usage = await agencyBudgetUsage(
    scope.workspaceId,
    new Date(Date.now() - agencyBudgetWindowMs)
  );
  // An action class with no authorized action (`other`) stays refused even
  // when the pilot runs without limits.
  const limit =
    agencyLimited(scope.workspaceId) || actionClass === "other"
      ? budgetRefusal(usage, actionClass)
      : undefined;
  if (limit !== undefined) return refused(limit);

  const inputHash = agencyInputHash(action.tool, action.input);
  if (await agencyActionRecorded(scope.workspaceId, inputHash)) {
    return refused(
      "Nothing was done: this action was already taken in an earlier run or is still being taken. Do not retry it."
    );
  }

  if (action.text !== undefined) {
    const profile = await readUserProfile(scope);
    if (
      disclosesHomeDetail({ goal: action.goal, profile, text: action.text })
    ) {
      return refused(
        "Nothing was done: the text gives out the person's home address or phone number, which their own request did not name. Remove it and do not retry the action unchanged."
      );
    }
  }
  return "not-applicable";
}
