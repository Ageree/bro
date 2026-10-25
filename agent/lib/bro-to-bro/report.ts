import type { AttachSessionFn } from "eve/channels";
import type { ScheduleToFn } from "eve/schedules";
import photon from "@agent/channels/photon";
import telegram from "@agent/channels/telegram";
import { telegramChatIdFromConversationId } from "@agent/lib/telegram-conversation";
import {
  claimBroReports,
  finishBroReport,
  parkBroReport,
} from "@db/services/bro-to-bro/reports";
import { broReportRoute } from "@db/services/bro-to-bro/route";
import { reportPeerUnreachable } from "@db/services/bro-to-bro/transitions";
import { broToBroV2 } from "@db/services/bro-to-bro/version";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import { broReportAuthenticator } from "./report-caller";
import { broReportMessage } from "./report-text";

/**
 * How long a report handed to its conversation waits for its turn before
 * it goes out again: the turn renews it at its start and every step
 * (`agent/hooks/bro-report.ts`), and a conversation's queue may hold it
 * behind a long turn of the owner's.
 */
const handedOverLeaseMs = 10 * 60_000;
const dispatchTimeoutMs = 20_000;

/** What waits for an owner in a thread report: what their peer would wait on. */
const awaitedKinds = new Set(["agreed", "held", "question"] as const);

/**
 * Hands every due Bro ↔ Bro report to its owner as a turn of its own, as
 * `deliverPhoneReports` does a call's (`agent/lib/phone/report.ts`): the
 * text is code's (`broReportMessage`), the turn waits in the conversation's
 * queue, and its caller (`bro-result`) speaks for nobody. A conversation
 * that took the report, or may have, holds it until its turn settles it; a
 * failed dispatch is retried with a backoff, and an owner with no chat at
 * all has the report dropped with that reason.
 */
export async function deliverBroReports(delivery: {
  readonly attachSession?: AttachSessionFn;
  readonly to: ScheduleToFn;
}) {
  const rows = await claimBroReports({
    leaseMs: handedOverLeaseMs,
    limit: 20,
  });
  await Promise.all(
    rows.map(async (row) => {
      const route = await broReportRoute(row);
      if (!route && broToBroV2(row.workspaceId)) {
        // The second version's: the report waits for the owner's first
        // chat with Bro, and whoever waits for them hears they are not
        // reachable yet, rather than nothing.
        await parkBroReport(row.id, row.leaseToken);
        const waiting = [...awaitedKinds].find((kind) => kind === row.kind);
        if (row.threadId && waiting)
          await reportPeerUnreachable(row.threadId, row.workspaceId, waiting);
        return;
      }
      if (!route) {
        await finishBroReport(row.id, row.leaseToken, {
          delivered: false,
          error: "no chat",
          retry: false,
        });
        return;
      }
      const scope = { userId: row.userId, workspaceId: row.workspaceId };
      const message = broReportMessage(
        row,
        await readWorkspaceTimeZone(scope),
        {
          v2: broToBroV2(row.workspaceId),
        }
      );
      const attributes = {
        workspaceId: row.workspaceId,
        broReportId: row.id,
        broReportToken: row.leaseToken,
        conversationChannel: route.conversationChannel,
        conversationId: route.conversationId,
      };
      const options = {
        turnPolicy: "queue" as const,
        auth: {
          authenticator: broReportAuthenticator,
          principalType: "user" as const,
          principalId: row.userId,
          issuer: "open-instinct",
          attributes:
            row.threadId === null
              ? attributes
              : { ...attributes, broThreadId: row.threadId },
        },
      };
      async function dispatch() {
        if (!route) throw new Error("A Bro report needs a conversation.");
        if (route.conversationChannel === "photon") {
          await delivery
            .to(photon, {
              adapterName: "imessage",
              threadId: route.conversationId,
            })
            .send(message, options);
          return;
        }
        if (route.conversationChannel === "telegram") {
          const chatId = telegramChatIdFromConversationId(route.conversationId);
          if (!chatId) throw new Error("Missing Telegram report route.");
          await delivery.to(telegram, { chatId }).send(message, options);
          return;
        }
        if (!delivery.attachSession)
          throw new Error("Missing session report handle.");
        const sent = await delivery
          .attachSession(route.conversationId)
          .send(message, options);
        if (sent.status !== "accepted")
          throw new Error("Report was not accepted.");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          resolve("timeout");
        }, dispatchTimeoutMs);
      });
      try {
        // Accepted, or not answered yet: eve may take the report after the
        // wait ended, so it counts as handed over either way, and the lease
        // the claim set holds it for its turn.
        const outcome = await Promise.race([
          dispatch().then(() => "accepted" as const),
          deadline,
        ]);
        if (outcome === "timeout")
          console.warn("[bro-to-bro] report dispatch timed out", {
            reportId: row.id,
          });
      } catch {
        await finishBroReport(row.id, row.leaseToken, {
          delivered: false,
          error: "dispatch failed",
          retry: true,
        });
      } finally {
        clearTimeout(timer);
      }
    })
  );
}
