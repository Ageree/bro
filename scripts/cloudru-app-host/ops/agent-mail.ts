import { createHash } from "node:crypto";
import {
  ensureAgentMailbox,
  listAgentMessages,
  readAgentMessage,
  sendAgentMessage,
} from "@agent/lib/agent-mail/client";
import { readWorkspaceScope } from "@db/services/scope";
import { db } from "@db";

async function main() {
  const [action, workspaceId] = process.argv.slice(2);
  if ((action !== "provision" && action !== "self-test") || !workspaceId) {
    throw new Error("Usage: agent-mail.sh provision|self-test WORKSPACE_ID");
  }
  const scope = await readWorkspaceScope(workspaceId);
  if (!scope) throw new Error("An existing workspace is required.");
  const mailbox = await ensureAgentMailbox(scope);
  if (!mailbox) throw new Error("AgentMail is disabled for this workspace.");
  console.log(
    JSON.stringify({ email: mailbox.email, inboxId: mailbox.inboxId })
  );
  if (action === "provision") return;
  // Send only to this agent's own inbox, never to its owner's Gmail.
  const input = {
    to: [mailbox.email],
    subject: "AgentMail: проверка почты Бро",
    text: "Проверка собственной почты агента: создание, отправка, чтение и защита от повторной отправки.",
  };
  const operationId = "ops-agent-mail-self-test-v1";
  const first = await sendAgentMessage(scope, input, operationId);
  const replay = await sendAgentMessage(scope, input, operationId);
  if (first.message_id !== replay.message_id) {
    throw new Error("Replay returned a different sent message.");
  }
  const message = await readAgentMessage(scope, first.message_id);
  const listed = await listAgentMessages(scope, { limit: 20 });
  if (!listed.messages.some((item) => item.message_id === message.message_id)) {
    throw new Error("The sent message is missing from the agent inbox.");
  }
  console.log(
    JSON.stringify({
      status: "verified",
      persistentMailbox:
        (await ensureAgentMailbox(scope))?.inboxId === mailbox.inboxId,
      sendReplay: first.message_id === replay.message_id,
      read: message.message_id === first.message_id,
      list: true,
      operationHash: createHash("sha256")
        .update(operationId)
        .digest("hex")
        .slice(0, 12),
    })
  );
}

try {
  await main();
} catch {
  // Provider/database error objects may include credentials or SQL params.
  console.error(
    "AgentMail operation failed; no provider response or secret was logged."
  );
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
