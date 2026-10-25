import type { AccessScope } from "@shared/identity/access-scope";
import type { BroReportTarget } from "@db";
import { readChannelIdentity } from "@db/services/channel-identities";
import {
  readRememberedConversations,
  rememberedMessenger,
} from "@db/services/proactive";
import { broToBroV2 } from "./version";

/**
 * Where a report goes: the conversation its side started the thread from,
 * else the messenger the owner last wrote from, which has pushes, else the
 * web chat they last wrote in, as a schedule's report finds a person with
 * no messenger (`reportConversations`). Someone who never wrote to Bro at
 * all has the report in the cabinet and `bro_talk status` alone — unless
 * their side is the second version's and their account has the bot's
 * Telegram linked: their private chat with the bot, which the person
 * started themself when they linked it. Undefined when there is nowhere.
 */
export async function broReportRoute(report: {
  readonly target: BroReportTarget | null;
  readonly userId: string;
  readonly workspaceId: string;
}) {
  if (report.target) return report.target;
  const remembered = await readRememberedConversations(report.workspaceId);
  const known =
    remembered &&
    (rememberedMessenger(remembered) ??
      (remembered.webConversationId
        ? {
            conversationChannel: "eve" as const,
            conversationId: remembered.webConversationId,
          }
        : undefined));
  if (known || !broToBroV2(report.workspaceId)) return known ?? undefined;
  let identity;
  try {
    identity = await readChannelIdentity(report, "telegram");
  } catch {
    // Not a Better Auth account: no Telegram of its own to write to.
    return undefined;
  }
  return identity
    ? {
        conversationChannel: "telegram" as const,
        conversationId: `${identity.chatId}::`,
      }
    : undefined;
}

/**
 * Whether Bro can write to this owner first (the second version's cabinet
 * says so when it cannot): any chat their reports could go to.
 */
export async function broOwnerReachable(scope: AccessScope) {
  return (await broReportRoute({ ...scope, target: null })) !== undefined;
}
