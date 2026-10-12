import { env } from "@shared/environment";

/**
 * Whether a workspace's proactive checks may run as the agentic worker
 * (`agent/lib/mode.ts`): the pilot named in AGENCY_WORKSPACES by workspace id,
 * or everyone with `*`. The list takes ids only, not emails, so the verdict
 * needs no lookup and holds for every step of a run.
 */
export function agencyPilot(workspaceId: string) {
  const list = env.AGENCY_WORKSPACES ?? [];
  return list.includes("*") || list.includes(workspaceId);
}
