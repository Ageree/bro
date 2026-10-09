import type { AttachSessionFn } from "eve/channels";
import type { ScheduleToFn } from "eve/schedules";
import photon from "@agent/channels/photon";
import telegram from "@agent/channels/telegram";
import { telegramChatIdFromConversationId } from "@agent/lib/telegram-conversation";
import {
  claimLoginHandoffReports,
  markLoginHandoffReportDelivered,
  releaseLoginHandoffReport,
} from "@db/services/login-handoffs";

/** Past this a send is given up on for this tick and tried again by the next. */
const sendTimeoutMs = 20_000;

/**
 * Hand each owed report to the conversation its link was asked for in, as a
 * turn of Bro's own (`login-handoff-result`: it speaks for nobody, so it can
 * start nothing on the person's behalf). A report sent but not yet answered
 * counts as delivered: a second copy beside it would be a second paid turn.
 * A report that could not be sent is released for the next tick, and given up
 * on after five.
 */
export async function deliverLoginHandoffReports(delivery: {
  readonly attachSession?: AttachSessionFn;
  readonly to: ScheduleToFn;
}) {
  const rows = await claimLoginHandoffReports(new Date());
  await Promise.all(
    rows.map(async (row) => {
      if (row.report === null) return;
      const message = row.report;
      const options = {
        auth: {
          attributes: {
            conversationChannel: row.conversationChannel,
            conversationId: row.conversationId,
            loginHandoffId: row.id,
            workspaceId: row.workspaceId,
          },
          authenticator: "login-handoff-result",
          issuer: "open-instinct",
          principalId: row.createdByUserId,
          principalType: "user" as const,
        },
        turnPolicy: "queue" as const,
      };
      async function dispatch() {
        if (row.conversationChannel === "photon") {
          await delivery
            .to(photon, {
              adapterName: "imessage",
              threadId: row.conversationId,
            })
            .send(message, options);
          return;
        }
        if (row.conversationChannel === "telegram") {
          const chatId = telegramChatIdFromConversationId(row.conversationId);
          if (!chatId) throw new Error("A Telegram report needs a chat id.");
          await delivery.to(telegram, { chatId }).send(message, options);
          return;
        }
        // A web chat has no channel address: only a handle on its session
        // reaches it.
        if (!delivery.attachSession) {
          throw new Error("A web chat needs a session handle.");
        }
        const sent = await delivery
          .attachSession(row.conversationId)
          .send(message, options);
        if (sent.status !== "accepted") {
          throw new Error("The report was not accepted.");
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          resolve("timeout");
        }, sendTimeoutMs);
      });
      try {
        const outcome = await Promise.race([
          dispatch().then(() => "sent" as const),
          deadline,
        ]);
        if (outcome === "timeout") {
          console.warn("[login-handoff] a report was slow to send", {
            id: row.id,
          });
        }
        await markLoginHandoffReportDelivered(row.id, new Date());
      } catch (error) {
        console.warn("[login-handoff] a report could not be sent", {
          cause: error,
          id: row.id,
        });
        await releaseLoginHandoffReport(row.id);
      } finally {
        clearTimeout(timer);
      }
    })
  );
}
