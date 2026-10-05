import { createAgentMailInbox } from "@shared/agent-mail/api";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  readAgentMailbox,
  saveAgentMailbox,
} from "@db/services/agent-mailboxes";

export function agentMailboxEnabled(scope: AccessScope) {
  return Boolean(
    env.AGENTMAIL_API_KEY &&
    env.AGENTMAIL_WORKSPACES?.some(
      (entry) => entry === "*" || entry === scope.workspaceId
    )
  );
}

export async function provisionAgentMailbox(scope: AccessScope) {
  if (!agentMailboxEnabled(scope)) return null;
  const existing = await readAgentMailbox(scope);
  if (existing) return existing;
  // Provider client_id survives a crash between creation and persistence,
  // and coordinates simultaneous first requests across web/eve processes.
  return saveAgentMailbox(scope, await createAgentMailInbox(scope.workspaceId));
}
