import { env } from "@shared/environment";
import { directModelActive } from "@shared/model/provider";
import { objectStorageConfigured } from "@shared/object-storage/s3";

export function sandboxHostConfigured() {
  return (
    env.SANDBOX_HOST_ID !== undefined &&
    env.SANDBOX_HOST_ORIGIN !== undefined &&
    env.SANDBOX_SIGNING_KEY !== undefined
  );
}

/**
 * Whether the person's files reach the task agent in this workspace
 * (TASK_FILES_WORKSPACES, docs/roadmap.md item 30): only inside the task
 * agent's pilot, and decided without a lookup, so ingestion, the skill's
 * setup and both hooks agree: SANDBOX_WORKSPACES must name the workspace by
 * id or be `*` (a pilot named only by the owner's email stays out), and the
 * files travel through the object store (`agent/lib/sandbox/inbox.ts`). The
 * web chat reads it too, to offer the attach button.
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
