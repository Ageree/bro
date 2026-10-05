import { createHash } from "node:crypto";
import { agentMailboxEnabled } from "@db/services/agent-mail";
import {
  claimAgentMailSend,
  completeAgentMailSend,
  readAgentMailbox,
} from "@db/services/agent-mailboxes";
import { ensureScope } from "@db/services/scope";
import {
  listAgentMailMessages,
  readAgentMailMessage,
  sendAgentMailMessage,
} from "@shared/agent-mail/api";
import type { AccessScope } from "@shared/identity/access-scope";

export async function ensureAgentMailbox(scope: AccessScope) {
  if (!agentMailboxEnabled(scope)) return null;
  const existing = await readAgentMailbox(scope);
  if (existing) return existing;
  await ensureScope(scope);
  const mailbox = await readAgentMailbox(scope);
  if (!mailbox)
    throw new Error("AgentMail mailbox provisioning is unavailable.");
  return mailbox;
}

async function requireMailbox(scope: AccessScope) {
  const mailbox = await ensureAgentMailbox(scope);
  if (!mailbox) throw new Error("AgentMail is not enabled for this agent.");
  return mailbox;
}

export async function listAgentMessages(
  scope: AccessScope,
  input: Parameters<typeof listAgentMailMessages>[1]
) {
  const mailbox = await requireMailbox(scope);
  return listAgentMailMessages(mailbox.inboxId, input);
}

export async function readAgentMessage(scope: AccessScope, messageId: string) {
  const mailbox = await requireMailbox(scope);
  return readAgentMailMessage(mailbox.inboxId, messageId);
}

export async function sendAgentMessage(
  scope: AccessScope,
  input: Parameters<typeof sendAgentMailMessage>[1],
  operationId: string
) {
  const mailbox = await requireMailbox(scope);
  const payloadHash = createHash("sha256")
    .update(JSON.stringify({ inboxId: mailbox.inboxId, ...input }))
    .digest("hex");
  const { row } = await claimAgentMailSend(scope, { operationId, payloadHash });
  if (row.messageId && row.threadId) {
    return { message_id: row.messageId, thread_id: row.threadId };
  }
  // AgentMail expires send keys after 24h. An interrupted operation older
  // than 23h has an unknown outcome: it must never silently send again.
  if (Date.now() - row.createdAt.getTime() >= 23 * 60 * 60_000) {
    throw new Error(
      "The earlier send has an unknown outcome. Check sent mail before requesting a new send."
    );
  }
  const key = `bro-send-${createHash("sha256")
    .update(`${scope.workspaceId}\n${operationId}`)
    .digest("hex")}`;
  const receipt = await sendAgentMailMessage(mailbox.inboxId, input, key);
  await completeAgentMailSend(scope, {
    operationId,
    messageId: receipt.message_id,
    threadId: receipt.thread_id,
  });
  return receipt;
}
