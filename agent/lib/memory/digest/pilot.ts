import { listsWorkspace } from "@agent/lib/workspace-list";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * Whether the digest folds a workspace's duplicate memories together:
 * MEMORY_DIGEST_WORKSPACES names the pilot by workspace id or owner's email,
 * as BROWSER_VM_WORKSPACES does, or everyone with `*`. A failed lookup of
 * the email keeps the workspace out for the day.
 */
export async function memoryDigestPilot(scope: AccessScope) {
  const list = env.MEMORY_DIGEST_WORKSPACES ?? [];
  if (list.includes("*")) return true;
  try {
    return await listsWorkspace(list, scope);
  } catch (error) {
    // The day's cleanup of codes still runs; only the merges wait.
    console.warn("[memory-digest] pilot lookup failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}

/** Whether the digest has a pilot at all: without one it runs for no one. */
export function memoryDigestConfigured() {
  return (env.MEMORY_DIGEST_WORKSPACES ?? []).length > 0;
}

/**
 * The pilot as the list of due workspaces filters it: everyone, or its
 * workspace ids and owners' emails.
 */
export function memoryDigestPilotEntries() {
  const list = env.MEMORY_DIGEST_WORKSPACES ?? [];
  if (list.includes("*")) return "everyone" as const;
  return {
    emails: list
      .filter((entry) => entry.includes("@"))
      .map((entry) => entry.toLowerCase()),
    ids: list.filter((entry) => !entry.includes("@")),
  };
}
