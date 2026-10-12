import { listAgentMessages } from "@agent/lib/agent-mail/client";
import {
  agentMailSignals,
  mailSearchStart,
} from "@agent/lib/proactive/signals";
import type { ProactiveSignal } from "@db/services/proactive";
import { agentMailboxEnabled } from "@db/services/agent-mail";
import { readAgentMailbox } from "@db/services/agent-mailboxes";
import type { AccessScope } from "@shared/identity/access-scope";

/** One page of the agent's inbox: a check reads no more than its newest. */
const pageSize = 50;

/**
 * The agent's inbox since the last check, for the agency pilot. The listing
 * has no time filter, so the watermark is applied here (`agentMailSignals`).
 * A workspace without a mailbox has nothing to read and no check at all; a
 * mailbox's first check starts its watermark at `now` and hands over nothing,
 * so mail from before the pilot is not replayed. A failed read is logged and
 * leaves the watermark where it was.
 */
export async function agentMailCheck(
  scope: AccessScope,
  mailCheckedAt: Date | null,
  now: Date
): Promise<
  { readonly checkedAt: Date; readonly signals: ProactiveSignal[] } | undefined
> {
  try {
    if (!agentMailboxEnabled(scope) || !(await readAgentMailbox(scope))) {
      return undefined;
    }
    if (mailCheckedAt === null) return { checkedAt: now, signals: [] };
    const page = await listAgentMessages(scope, { limit: pageSize });
    return {
      checkedAt: now,
      signals: agentMailSignals(
        page.messages,
        mailSearchStart(mailCheckedAt, now)
      ),
    };
  } catch (error) {
    console.warn("[proactive] agent mail check failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
}
