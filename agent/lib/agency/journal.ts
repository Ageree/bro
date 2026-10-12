import { createHash } from "node:crypto";
import type { ApprovalContext } from "eve/tools/approval";
import { z } from "zod";
import type { agencyActions } from "@db";
import { beginAgencyAction, finishAgencyAction } from "@db/services/agency";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import type { AgencyActionClass } from "./budget";

type JsonValue = z.infer<ReturnType<typeof z.json>>;

/** The call that reverses a done action, as the journal keeps it. */
export type AgencyUndo = NonNullable<typeof agencyActions.$inferInsert.undo>;

/** One outbound action of the agentic worker, as the journal records it. */
interface AgencyCall {
  readonly actionClass: AgencyActionClass;
  readonly counterparty?: string;
  /** The call's input as JSON text, already parsed by the tool's schema. */
  readonly input: string;
  readonly tool: string;
}

/** Keys in sorted order, so one input hashes the same whatever its key order. */
function sortedKeys(_key: string, value: JsonValue): JsonValue {
  if (value === null || Array.isArray(value) || !(value instanceof Object)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).toSorted(([left], [right]) => (left < right ? -1 : 1))
  );
}

/**
 * The idempotency key of an action: its tool and its input. The same run
 * that retries the action computes the same key, and so does an approval
 * looking for a row the run already wrote.
 */
export function agencyInputHash(tool: string, input: string) {
  const parsed = z.json().parse(JSON.parse(input));
  return createHash("sha256")
    .update(`${tool}\n${JSON.stringify(parsed, sortedKeys)}`)
    .digest("hex");
}

const duplicateRefusal =
  "Nothing was done: this action was already taken in an earlier run or is still being taken. Do not retry it.";

/**
 * Runs one action of the agentic worker through the journal: planned before
 * the call, done after it, failed when it throws. A repeat of the same input
 * finds its row and is refused, so a retried run never takes the action
 * twice; a failed action is not retried either, since its outcome may be
 * unknown. Any other turn runs `run` as it is.
 */
export async function journaledAgencyCall<T>(
  context: Pick<ApprovalContext, "session">,
  call: AgencyCall,
  run: () => Promise<T>,
  undoOf?: (result: T) => AgencyUndo | null
): Promise<T> {
  if (resolveModeValue(context, { "agentic-worker": true }) !== true) {
    return run();
  }
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  if (caller?.principalType !== "user") {
    throw new Error(
      "The agentic worker needs an authenticated workspace user."
    );
  }
  const scope = scopeFromPrincipal(caller);
  const begun = await beginAgencyAction({
    actionClass: call.actionClass,
    counterparty: call.counterparty ?? null,
    inputHash: agencyInputHash(call.tool, call.input),
    runId: context.session.id,
    summary:
      call.counterparty === undefined
        ? call.tool
        : `${call.tool}: ${call.counterparty}`,
    tool: call.tool,
    undo: null,
    workspaceId: scope.workspaceId,
  });
  if (begun.kind === "duplicate") throw new Error(duplicateRefusal);

  let result: T;
  try {
    result = await run();
  } catch (error) {
    await finishAgencyAction(begun.id, "failed");
    throw error;
  }
  await finishAgencyAction(begun.id, "done", undoOf?.(result) ?? null);
  return result;
}
