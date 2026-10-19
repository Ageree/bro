import type { AttachSessionFn } from "eve/channels";
import type { ScheduleToFn } from "eve/schedules";
import type { ToolContext } from "eve/tools";
import type { ModelMessage } from "ai";
import { z } from "zod";
import photon from "@agent/channels/photon";
import telegram from "@agent/channels/telegram";
import { startsTurn } from "@agent/lib/delivery/turn-sends";
import {
  telegramChatIdFromConversationId,
  telegramConversationIdSchema,
} from "@agent/lib/telegram-conversation";
import {
  claimYoomoneyOnboardingResumes,
  releaseYoomoneyOnboardingResume,
} from "@db/services/yoomoney/onboarding";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import { env } from "@shared/environment";

/**
 * Connecting the wallet from a chat, on Bro's side: where the person asked
 * (`conversationOf`), the button that opens the page in Telegram, and the
 * turn that carries on in the chat once the page is through
 * (`db/services/yoomoney/onboarding.ts`).
 */

/** The chat this turn is in, as a payment or an onboarding keeps it. */
export function conversationOf(context: ToolContext) {
  const attributes = context.session.auth.current?.attributes;
  const channel = z
    .enum(["eve", "photon", "telegram"])
    .safeParse(attributes?.conversationChannel).data;
  const conversationId =
    channel === "eve"
      ? context.session.id
      : channel === "photon"
        ? z
            .string()
            .startsWith("imessage:")
            .safeParse(attributes?.conversationId).data
        : telegramConversationIdSchema.safeParse(attributes?.conversationId)
            .data;
  return channel === undefined || conversationId === undefined
    ? { conversationChannel: null, conversationId: null }
    : { conversationChannel: channel, conversationId };
}

const telegramReplySchema = z.object({ ok: z.boolean() });

/**
 * The button that opens the page in Telegram as a Mini App, under a line of
 * text: only a `web_app` button gives the page Telegram's signed data of
 * the person, and only Bro's code can send one — the model's messages carry
 * no buttons. Throws when it did not land.
 */
export async function sendYoomoneyConnectButton(
  conversationId: string,
  url: string,
  anew: boolean
) {
  const chatId = telegramChatIdFromConversationId(conversationId);
  const botToken = env.TELEGRAM_BOT_TOKEN;
  if (!chatId || !botToken) {
    throw new Error("Telegram is not set up for this conversation.");
  }
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      body: JSON.stringify({
        chat_id: chatId,
        text: anew
          ? "Разреши мне платить заново — там можно указать, на какую сумму в сутки. Пока не разрешишь, всё работает как сейчас."
          : "Подключи ЮMoney — это один раз и около минуты. Дальше я плачу сам, каждый раз после твоего «да».",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: anew ? "Разрешить в ЮMoney" : "Подключить ЮMoney",
                web_app: { url },
              },
            ],
          ],
        },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    }
  );
  const accepted = telegramReplySchema.safeParse(
    await response.json().catch(() => undefined)
  ).data?.ok;
  if (!response.ok || accepted !== true) {
    throw new Error(`Telegram button failed (${String(response.status)}).`);
  }
}

/** The caller of the turn that carries on after the wallet was connected. */
const resumeAuthenticator = "yoomoney-connected";

const resumeCallerSchema = z.object({
  authenticator: z.literal(resumeAuthenticator),
  attributes: z.object({ yoomoneyOnboardingId: z.string() }),
});

/** The onboarding a turn carries on from, when Bro's tick opened it. */
export function resumedYoomoneyOnboardingId(
  caller: ToolContext["session"]["auth"]["current"]
) {
  return resumeCallerSchema.safeParse(caller).data?.attributes
    .yoomoneyOnboardingId;
}

const resumeMessage = [
  backgroundTurnMarker,
  "The person has just connected their YooMoney wallet (or allowed it anew) on the page Bro's link opened. This is Bro's own note, not the person's message or permission. If, before that, the person asked Bro to pay something that yoomoney_pay pays (a phone, internet, utilities, a transfer), carry on with it now: prepare it with yoomoney_pay (find, then prepare with the fields from the person's earlier words) and send its confirmationQuestion — only their yes pays it. If they asked for nothing to pay, say in one short line in Russian that the wallet is connected and Bro can pay from it now. Never say how you learned it; never call yoomoney_pay confirm in this turn.",
].join("\n\n");

/**
 * Whether the tick's own message opened this turn. eve keeps a turn's
 * caller for a later delivery that brings none (a task's report,
 * `turn-step.js`), so the caller alone would let such a turn — its text a
 * file's or a page's — prepare a payment too. Only the message's exact
 * opening counts: eve's deliveries open with their own wording.
 */
export function openedByYoomoneyResume(messages: readonly ModelMessage[]) {
  const opener = messages.findLast(startsTurn);
  if (opener === undefined) return false;
  const text = Array.isArray(opener.content)
    ? opener.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
    : opener.content;
  return text.startsWith(resumeMessage);
}

/** Past this a send is given up on for this tick and tried again by the next. */
const sendTimeoutMs = 20_000;

/**
 * Each onboarding whose page is through tells its chat, as a turn of Bro's
 * own: the conversation carries on where it stopped, at the payment the
 * person asked for. Sent but not answered counts as told; one that could
 * not be sent is released for the next tick, within the hour.
 */
export async function resumeYoomoneyOnboardings(
  delivery: {
    readonly attachSession?: AttachSessionFn;
    readonly to: ScheduleToFn;
  },
  now: Date
) {
  const rows = await claimYoomoneyOnboardingResumes(now);
  await Promise.all(
    rows.map(async (row) => {
      const options = {
        auth: {
          attributes: {
            conversationChannel: row.conversationChannel,
            conversationId: row.conversationId,
            workspaceId: row.workspaceId,
            yoomoneyOnboardingId: row.id,
          },
          authenticator: resumeAuthenticator,
          issuer: "open-instinct",
          principalId: row.userId,
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
            .send(resumeMessage, options);
          return;
        }
        if (row.conversationChannel === "telegram") {
          const chatId = telegramChatIdFromConversationId(row.conversationId);
          if (!chatId) throw new Error("A Telegram chat needs a chat id.");
          await delivery.to(telegram, { chatId }).send(resumeMessage, options);
          return;
        }
        // A web chat has no channel address: only a handle on its session.
        if (!delivery.attachSession) {
          throw new Error("A web chat needs a session handle.");
        }
        const sent = await delivery
          .attachSession(row.conversationId)
          .send(resumeMessage, options);
        if (sent.status !== "accepted") {
          throw new Error("The web chat did not take the turn.");
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
        console.info("[yoomoney] onboarding resumed", {
          id: row.id,
          channel: row.conversationChannel,
          slow: outcome === "timeout",
        });
      } catch (error) {
        console.warn("[yoomoney] onboarding could not be resumed", {
          id: row.id,
          name: error instanceof Error ? error.name : "unknown",
        });
        await releaseYoomoneyOnboardingResume(row.id, now);
      } finally {
        clearTimeout(timer);
      }
    })
  );
}
