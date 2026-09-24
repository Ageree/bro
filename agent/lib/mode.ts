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

/**
 * The channels a person writes to Bro through: the web chat, the local dev
 * sign-in the benchmark drives, Telegram and iMessage. Every other caller is
 * Bro writing to itself — a browser run's report (`browser-result`), a
 * schedule's worker, its answer or its report — and speaks for nobody.
 */
const personAuthenticators = new Set([
  "authjs",
  "local-dev",
  "photon-imessage",
  "telegram-webhook",
]);

/**
 * Whether this turn was started by the person's own message. The report of a
 * browser run is an interactive turn too, but its text is the page's, not
 * the person's: a standing permission or an earlier confirmation must never
 * act on it, only a card the person answers.
 */
export function startedByPerson(context: AgentModeContext) {
  if (resolveModeValue(context, { interactive: true }) !== true) return false;
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  return (
    caller?.principalType === "user" &&
    personAuthenticators.has(caller.authenticator)
  );
}

export function resolveModeInstructions(
  context: DynamicResolveContext,
  contentByMode: Partial<Record<AgentMode, string>>
) {
  const content = resolveModeValue(context, contentByMode);
  return content === null ? null : defineInstructions({ content });
}
