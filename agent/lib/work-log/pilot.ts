import { env } from "@shared/environment";

/**
 * Whether the workspace keeps what Bro did across its chats
 * (WORK_LOG_WORKSPACES, ids or `*`): decided without a lookup, as every hook
 * of a turn asks it.
 */
export function workLogEnabled(workspaceId: string) {
  const list = env.WORK_LOG_WORKSPACES ?? [];
  return list.includes("*") || list.includes(workspaceId);
}
