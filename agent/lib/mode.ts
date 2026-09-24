import type { DynamicResolveContext } from "eve";
import { defineInstructions } from "eve/instructions";

interface AgentModeContext {
  readonly session: {
    readonly auth: Pick<
      DynamicResolveContext["session"]["auth"],
      "current" | "initiator"
    >;
  };
}

function agentMode(authenticator: string | undefined) {
  if (authenticator === "scheduled-worker") return "scheduled-worker" as const;
  if (authenticator === "scheduled-result") return "scheduled-report" as const;
  return "interactive" as const;
}

type AgentMode = ReturnType<typeof agentMode> | "proactive-worker";

// Bro's own mail and calendar checks run as scheduled workers with a
// narrower toolset and their own role, so they are a mode of their own.
function workerMode(
  worker: Pick<
    NonNullable<AgentModeContext["session"]["auth"]["initiator"]>,
    "attributes"
  >
) {
  return worker.attributes.scheduledRunKind === "proactive"
    ? ("proactive-worker" as const)
    : ("scheduled-worker" as const);
}

function sessionAgentMode(auth: AgentModeContext["session"]["auth"]) {
  if (auth.initiator?.authenticator === "scheduled-worker") {
    return workerMode(auth.initiator);
  }
  const caller = auth.current ?? auth.initiator;
  if (caller?.authenticator === "scheduled-worker") return workerMode(caller);
  return agentMode(caller?.authenticator);
}

export function resolveModeValue<T>(
  context: AgentModeContext,
  valueByMode: Partial<Record<AgentMode, T>>
) {
  return valueByMode[sessionAgentMode(context.session.auth)] ?? null;
}

export function resolveModeInstructions(
  context: DynamicResolveContext,
  contentByMode: Partial<Record<AgentMode, string>>
) {
  const content = resolveModeValue(context, contentByMode);
  return content === null ? null : defineInstructions({ content });
}
