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
