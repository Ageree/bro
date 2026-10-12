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

/**
 * Whether the agentic worker's daily limits apply to a workspace: always,
 * unless the pilot runs without them (`AGENCY_LIMITS=off`).
 */
export function agencyLimited(workspaceId: string) {
  return !(agencyPilot(workspaceId) && env.AGENCY_LIMITS === "off");
}

/**
 * The most proactive runs a workspace gets in 24 hours: `limit` while the
 * limits apply, no cap in the pilot that runs without them.
 */
export function proactiveRunCap(workspaceId: string, limit: number) {
  return agencyLimited(workspaceId) ? limit : Number.MAX_SAFE_INTEGER;
}
