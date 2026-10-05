import { and, eq, isNull } from "drizzle-orm";
import { agentMailboxes, agentMailSends, db } from "@db";
import type { AccessScope } from "@shared/identity/access-scope";

type AgentMailboxInput = Omit<
  typeof agentMailboxes.$inferInsert,
  "createdAt" | "workspaceId"
>;

/** Reads the workspace agent's own inbox, if it has been provisioned. */
export async function readAgentMailbox(scope: AccessScope) {
  const [mailbox] = await db
    .select()
    .from(agentMailboxes)
    .where(eq(agentMailboxes.workspaceId, scope.workspaceId))
    .limit(1);
  return mailbox;
}

/**
 * Records an inbox after its workspace exists. Replays and concurrent creation
 * keep the first binding, so an agent's address cannot change silently.
 */
export async function saveAgentMailbox(
  scope: AccessScope,
  mailbox: AgentMailboxInput
) {
  const [inserted] = await db
    .insert(agentMailboxes)
    .values({ ...mailbox, workspaceId: scope.workspaceId })
    .onConflictDoNothing({ target: agentMailboxes.workspaceId })
    .returning();
  const stored = inserted ?? (await readAgentMailbox(scope));
  if (!stored) throw new Error("The agent mailbox could not be recorded.");
  return stored;
}

type AgentMailSendInput = Pick<
  typeof agentMailSends.$inferInsert,
  "operationId" | "payloadHash"
>;

/** Returns the durable claim or receipt for this workspace's send operation. */
async function readAgentMailSend(scope: AccessScope, operationId: string) {
  const [send] = await db
    .select()
    .from(agentMailSends)
    .where(
      and(
        eq(agentMailSends.workspaceId, scope.workspaceId),
        eq(agentMailSends.operationId, operationId)
      )
    )
    .limit(1);
  return send;
}

/** Claims an operation once and rejects reusing its identity for another email. */
export async function claimAgentMailSend(
  scope: AccessScope,
  send: AgentMailSendInput
) {
  const [inserted] = await db
    .insert(agentMailSends)
    .values({ ...send, workspaceId: scope.workspaceId })
    .onConflictDoNothing({
      target: [agentMailSends.workspaceId, agentMailSends.operationId],
    })
    .returning();
  const row = inserted ?? (await readAgentMailSend(scope, send.operationId));
  if (!row) throw new Error("The agent email operation could not be recorded.");
  if (row.payloadHash !== send.payloadHash) {
    throw new Error(
      "The agent email operation was already used for another email."
    );
  }
  return { first: Boolean(inserted), row };
}

/** Stores the first delivery receipt and keeps it available beyond API retries. */
export async function completeAgentMailSend(
  scope: AccessScope,
  receipt: Pick<typeof agentMailSends.$inferSelect, "operationId"> & {
    readonly messageId: string;
    readonly threadId: string;
  }
) {
  const [completed] = await db
    .update(agentMailSends)
    .set({ messageId: receipt.messageId, threadId: receipt.threadId })
    .where(
      and(
        eq(agentMailSends.workspaceId, scope.workspaceId),
        eq(agentMailSends.operationId, receipt.operationId),
        isNull(agentMailSends.messageId)
      )
    )
    .returning();
  const row =
    completed ?? (await readAgentMailSend(scope, receipt.operationId));
  if (!row) throw new Error("The agent email operation has not been claimed.");
  return row;
}
