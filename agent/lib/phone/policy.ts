import { createHash } from "node:crypto";
import { defineState, type SessionContext } from "eve/context";
import type { ToolContext } from "eve/tools";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";

const phoneTurn = defineState<{
  turnId: string | null;
  authorized: boolean;
  sawMessage: boolean;
  background: boolean;
}>("bro.phone-person-turn", () => ({
  turnId: null,
  authorized: false,
  sawMessage: false,
  background: false,
}));

const phoneActions = defineState<{
  actions: readonly {
    callId: string;
    sessionId: string;
    turnId: string;
    toolName: string;
    inputHash: string;
    userId: string;
    workspaceId: string;
  }[];
}>("bro.phone-authorized-actions", () => ({ actions: [] }));

export function recordPhoneAction(
  context: Pick<ToolContext, "session" | "callId" | "toolName">,
  serializedInput: string
) {
  if (!authorizedPhoneTurn(context.session)) return;
  const caller = context.session.auth.current;
  if (caller?.principalType !== "user") return;
  const scope = scopeFromPrincipal(caller);
  const action = {
    ...scope,
    callId: context.callId,
    sessionId: context.session.id,
    turnId: context.session.turn.id,
    toolName: context.toolName,
    inputHash: createHash("sha256").update(serializedInput).digest("hex"),
  };
  phoneActions.update((state) => ({
    actions: [
      ...state.actions.filter((known) => known.callId !== context.callId),
      action,
    ].slice(-50),
  }));
}

export function phoneActionTurn(
  context: Pick<ToolContext, "session" | "callId" | "toolName">,
  serializedInput: string
) {
  if (context.session.parent || !startedByPerson(context)) return null;
  const caller = context.session.auth.current;
  if (caller?.principalType !== "user") return null;
  const scope = scopeFromPrincipal(caller);
  try {
    const turn = phoneTurn.get();
    if (
      turn.turnId !== context.session.turn.id ||
      turn.background ||
      (turn.sawMessage && !turn.authorized)
    )
      return null;
    const hash = createHash("sha256").update(serializedInput).digest("hex");
    const action = phoneActions
      .get()
      .actions.find(
        (known) =>
          known.callId === context.callId &&
          known.sessionId === context.session.id &&
          known.toolName === context.toolName &&
          known.inputHash === hash &&
          known.userId === scope.userId &&
          known.workspaceId === scope.workspaceId
      );
    return action?.turnId ?? null;
  } catch {
    return null;
  }
}

export function recordPhoneTurn(
  session: SessionContext["session"],
  source: "start" | "person-message" | "background-message"
) {
  phoneTurn.update((previous) => {
    if (source === "start")
      return {
        turnId: session.turn.id,
        authorized: false,
        sawMessage: false,
        background: false,
      };
    const background =
      source === "background-message" ||
      Boolean(session.parent) ||
      !startedByPerson({ session }) ||
      (previous.turnId === session.turn.id && previous.background);
    return {
      turnId: session.turn.id,
      authorized: !background,
      sawMessage: true,
      background,
    };
  });
}

export function authorizedPhoneTurn(session: SessionContext["session"]) {
  if (session.parent || !startedByPerson({ session })) return false;
  try {
    const turn = phoneTurn.get();
    return (
      turn.authorized &&
      turn.sawMessage &&
      !turn.background &&
      turn.turnId === session.turn.id
    );
  } catch {
    return false;
  }
}
