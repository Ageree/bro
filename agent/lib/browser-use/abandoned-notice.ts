import {
  createiMessageAdapter,
  type iMessageAdapter,
} from "@photon-ai/chat-adapter-imessage";
import { z } from "zod";
import { takeAbandonedBrowserRunReports } from "@db/services/browser-runs";
import { telegramChatIdFromConversationId } from "@agent/lib/telegram-conversation";
import { env } from "@shared/environment";
import { photonProjectCredentials } from "@shared/photon/credentials";

const telegramApiBaseUrl = "https://api.telegram.org";
const sendTimeoutMs = 10_000;
const titleLength = 60;
const telegramReplySchema = z.object({ ok: z.boolean() });

let photonAdapter: iMessageAdapter | undefined;

type AbandonedRun = Awaited<
  ReturnType<typeof takeAbandonedBrowserRunReports>
>[number];

/** What the errand is called to the person: its site, else its first words. */
function errandTitle(run: Pick<AbandonedRun, "site" | "task">) {
  const host = run.site ? URL.parse(run.site)?.hostname : undefined;
  if (host) return host.replace(/^www\./, "");
  const task = run.task.replaceAll(/\s+/g, " ").trim();
  return task.length > titleLength ? `${task.slice(0, titleLength)}…` : task;
}

export function abandonedReportNotice(
  run: Pick<AbandonedRun, "site" | "task">
) {
  const title = errandTitle(run);
  return `Поручение «${title}» закончено, но итог не дошёл. Спросите меня «что там с ${title}», и я расскажу.`;
}

/**
 * Tell the people whose browser errand finished but whose report ran out of
 * delivery attempts, once each and without the model: the report turn is what
 * kept failing. A web chat has no address to send to, so it only gets a log
 * line; the person finds the result by asking, as the notice says.
 */
export async function noticeAbandonedBrowserRunReports(now = new Date()) {
  const runs = await takeAbandonedBrowserRunReports(now);
  await Promise.all(
    runs.map(async (run) => {
      try {
        const sent = await sendNotice(run);
        console.warn("[browser-use] undelivered report given up", {
          channel: run.conversationChannel,
          notified: sent,
          runId: run.id,
        });
      } catch (error) {
        console.warn("[browser-use] undelivered report notice failed", {
          cause: error,
          channel: run.conversationChannel,
          runId: run.id,
        });
      }
    })
  );
}

async function sendNotice(run: AbandonedRun) {
  const text = abandonedReportNotice(run);
  if (run.conversationChannel === "telegram") {
    const chatId = telegramChatIdFromConversationId(run.conversationId);
    const botToken = env.TELEGRAM_BOT_TOKEN;
    if (!chatId || !botToken) return false;
    const response = await fetch(
      `${telegramApiBaseUrl}/bot${botToken}/sendMessage`,
      {
        body: JSON.stringify({ chat_id: chatId, text }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(sendTimeoutMs),
      }
    );
    const accepted = telegramReplySchema.safeParse(
      await response.json().catch(() => undefined)
    ).data?.ok;
    if (!response.ok || accepted !== true) {
      throw new Error(`Telegram notice failed (${String(response.status)}).`);
    }
    return true;
  }
  if (run.conversationChannel === "photon") {
    photonAdapter ??= createiMessageAdapter({
      credentials: photonProjectCredentials,
    });
    await photonAdapter.postMessage(run.conversationId, { raw: text });
    return true;
  }
  return false;
}
