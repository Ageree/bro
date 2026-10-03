import type { SessionContext } from "eve/context";
import { z } from "zod";
import { directModelActive } from "@shared/model/provider";
import { objectStorageConfigured } from "@shared/object-storage/s3";
import {
  listsWorkspaceRemembered,
  pilotVerdictOfTurn,
} from "@agent/lib/workspace-list";
import { env } from "@shared/environment";
import { sandboxHostConfigured } from "./host";
import { conversationHoldsPersonFiles } from "./inbox";

/**
 * Whether a workspace's Bro may hand jobs to the task agent
 * (`agent/subagents/task`): only with the code sandbox host configured, only
 * with the direct model, RouterAI or OpenRouter (the task agent's model is
 * resolved per step like Bro's), and only for the pilot named in
 * SANDBOX_WORKSPACES by workspace id or owner's email, or everyone with `*`. Every interactive
 * step asks, so the verdict by email is remembered for a while; a failed
 * lookup of the email keeps the workspace out for that call. Asked with the
 * step's `turn`, the verdict holds for the whole turn (`pilotVerdictOfTurn`).
 */
export async function taskAgentPilot(
  scope: {
    readonly userId?: string;
    readonly workspaceId: string;
  },
  turn?: Parameters<typeof pilotVerdictOfTurn>[1]
) {
  const list = env.SANDBOX_WORKSPACES ?? [];
  if (list.length === 0 || !sandboxHostConfigured() || !directModelActive()) {
    return false;
  }
  if (list.includes("*")) return true;
  return pilotVerdictOfTurn("task-agent", turn, async () => {
    try {
      return await listsWorkspaceRemembered(list, scope);
    } catch (error) {
      console.warn("[sandbox] pilot lookup failed", { cause: error });
      return undefined;
    }
  });
}

/**
 * Whether the person's files reach the task agent in this workspace
 * (TASK_FILES_WORKSPACES, docs/roadmap.md item 30): only inside the task
 * agent's pilot, and decided without a lookup, so ingestion, the skill's
 * setup and both hooks agree: SANDBOX_WORKSPACES must name the workspace by
 * id or be `*` (a pilot named only by the owner's email stays out), and the
 * files travel through the object store (`agent/lib/sandbox/inbox.ts`).
 */
export function taskFilesEnabled(workspaceId: string | undefined) {
  if (workspaceId === undefined) return false;
  const files = env.TASK_FILES_WORKSPACES ?? [];
  const pilot = env.SANDBOX_WORKSPACES ?? [];
  return (
    (files.includes("*") || files.includes(workspaceId)) &&
    (pilot.includes("*") || pilot.includes(workspaceId)) &&
    sandboxHostConfigured() &&
    directModelActive() &&
    objectStorageConfigured()
  );
}

/**
 * Whether `taskFilesEnabled` holds for some workspace of this deployment,
 * decided from the settings alone (privacy facts, `agent/lib/privacy/facts.ts`):
 * a workspace both lists name by id, or `*` in one with an id in the other.
 * A pilot named only by owners' emails never matches a workspace id.
 */
export function taskFilesDeployed() {
  const files = env.TASK_FILES_WORKSPACES ?? [];
  const pilot = (env.SANDBOX_WORKSPACES ?? []).filter(
    (entry) => !entry.includes("@")
  );
  const overlap = pilot.includes("*")
    ? files.length > 0
    : files.includes("*")
      ? pilot.length > 0
      : files.some((id) => pilot.includes(id));
  return (
    overlap &&
    sandboxHostConfigured() &&
    directModelActive() &&
    objectStorageConfigured()
  );
}

const userCallerSchema = z.object({
  attributes: z.object({ workspaceId: z.string().min(1) }),
  principalType: z.literal("user"),
});

/**
 * `taskFilesEnabled` for the workspace of the caller that holds the turn: a
 * person signed in to a channel, or Bro's own caller in a subagent, which
 * carries the parent's auth. A caller without a workspace is out.
 */
export function taskFilesOfCaller(context: {
  readonly session: Pick<SessionContext["session"], "auth">;
}) {
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  return taskFilesEnabled(
    userCallerSchema.safeParse(caller).data?.attributes.workspaceId
  );
}

/**
 * Whether the guards over the person's files run: whenever Object Storage
 * is configured, whatever TASK_FILES_WORKSPACES says now. A conversation
 * whose task agent was given the files keeps their content in its history
 * and in reports still to come, so clearing the flag stops only new files
 * from moving: a task agent of a marked conversation still goes off the web
 * unless the person sent it (`agent/subagents/task/hooks/person-files.ts`),
 * and Bro's hook still records the person's sends for that check
 * (`agent/hooks/task-files.ts`). Without Object Storage no file ever moved.
 */
export function taskFilesGuarded() {
  return objectStorageConfigured();
}

/** A send waits on the conversation's mark at most this long. */
const sendCheckMs = 5000;

/**
 * Whether what Bro sends in this conversation must carry no URL a server
 * fetches before the person reads it (a report turn's links and
 * attachments, `agent/tools/messaging.ts`; Telegram's previews): the
 * person's files reach the task agent here, or some task agent of this
 * conversation was given them (its mark, `markSandboxHoldsPersonFiles`),
 * whatever TASK_FILES_WORKSPACES says now. Clearing the flag leaves the
 * files' content in the conversation's history and in reports still to
 * come. A mark that cannot be read counts as there; without Object Storage
 * no file ever moved.
 */
export async function conversationHoldsFiles(context: {
  readonly session: Pick<SessionContext["session"], "auth" | "id">;
}) {
  if (taskFilesOfCaller(context)) return true;
  if (!taskFilesGuarded()) return false;
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  const workspaceId =
    userCallerSchema.safeParse(caller).data?.attributes.workspaceId;
  // Bro's hook moves only the files of a caller with a workspace.
  if (workspaceId === undefined) return false;
  // Only the task agent's pilot ever had a helper to hand files to: every
  // other workspace's send reads no mark (`taskAgentPilot` is remembered).
  if (!(await taskAgentPilot({ workspaceId }))) return false;
  return await conversationHoldsPersonFiles(
    workspaceId,
    context.session.id,
    AbortSignal.timeout(sendCheckMs)
  ).catch(() => true);
}
