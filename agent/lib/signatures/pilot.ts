import type { SessionContext } from "eve/context";
import { env } from "@shared/environment";
import { callerWorkspaceId, taskFilesEnabled } from "@agent/lib/sandbox/pilot";

/**
 * Whether Bro may keep the person's signature and put it on their PDFs in
 * this workspace (SIGN_WORKSPACES, ids or `*`): only inside the files pilot
 * (`taskFilesEnabled`), and only where Bro's own sandbox is the code sandbox
 * host (AGENT_SANDBOX=bro-cloudru), whose Python runs the kit that finds the
 * places and stamps the signature (`agent/lib/signatures/commands.ts`); the
 * other sandboxes have none.
 */
export function signEnabled(workspaceId: string | undefined) {
  if (workspaceId === undefined) return false;
  const list = env.SIGN_WORKSPACES ?? [];
  return (
    (list.includes("*") || list.includes(workspaceId)) &&
    env.AGENT_SANDBOX === "bro-cloudru" &&
    taskFilesEnabled(workspaceId)
  );
}

/** {@link signEnabled} for the workspace of the caller that holds the turn. */
export function signOfCaller(context: {
  readonly session: Pick<SessionContext["session"], "auth">;
}) {
  return signEnabled(callerWorkspaceId(context));
}
