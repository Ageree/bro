import { z } from "zod";
import {
  claimOperationalAlert,
  clearOperationalAlert,
  confirmOperationalAlert,
  releaseOperationalAlertClaim,
} from "@db/services/operational-alerts";
import { env } from "@shared/environment";

const telegramApiBaseUrl = "https://api.telegram.org";
const requestTimeoutMs = 10_000;
const telegramReplySchema = z.object({ ok: z.boolean() });
/**
 * Sent through Bro's own bot, the alert lands in the owner's chat with Bro
 * and reads as Bro's words, though Bro never sees it (a bot gets no updates
 * about its own messages): Bro, asked about it, first denied it and then made
 * up where it came from. The header says whose it is.
 */
const viaBroHeader =
  "⚙️ Служебное уведомление для владельца: его прислала проверка сервера, а не Бро, и Бро его не видит.";

/**
 * Where the owner hears alerts, the same pair the host's watchdog uses: the
 * service bot OPS_ALERT_BOT_TOKEN in OPS_ALERT_CHAT_ID, each falling back to
 * Bro's own bot and the owner's chat with it. Nothing without a bot and chat.
 */
export function ownerAlertTarget() {
  const botToken = env.OPS_ALERT_BOT_TOKEN ?? env.TELEGRAM_BOT_TOKEN;
  const chatId = env.OPS_ALERT_CHAT_ID ?? env.TELEGRAM_OWNER_CHAT_ID;
  if (!botToken || !chatId) return undefined;
  return { botToken, chatId, viaBro: !env.OPS_ALERT_BOT_TOKEN };
}

/**
 * Tell the deployment's owner, in Telegram, about a condition only
 * they can fix: a balance to top up, reports that are not reaching people.
 * What was already said lives in `operational_alerts`, so two ticks that see
 * the same condition cannot both send, and the alert repeats only once
 * `repeatAfterMs` has passed or the value fell to half. An alert nobody
 * received is forgotten at once, so the next tick tries again; a sender that
 * died mid-send leaves a claim that lapses in two minutes. False when nothing
 * was sent: no alert chat is configured, or it was already said.
 */
export async function alertOwner(
  key: string,
  text: string,
  options: {
    readonly minimumDrop?: number;
    readonly now?: Date;
    readonly repeatAfterMs: number;
    readonly value?: number;
  }
) {
  const target = ownerAlertTarget();
  if (!target) return false;
  const now = options.now ?? new Date();
  const claim = await claimOperationalAlert(key, options.value ?? 0, {
    // Without a drop that counts, only time repeats the alert.
    minimumDrop: options.minimumDrop ?? Number.MAX_SAFE_INTEGER,
    now,
    repeatAfterMs: options.repeatAfterMs,
  });
  if (!claim) return false;
  try {
    await sendOwnerMessage(
      target.botToken,
      target.chatId,
      target.viaBro ? `${viaBroHeader}\n\n${text}` : text
    );
  } catch (error) {
    await releaseOperationalAlertClaim(key, claim, now);
    throw error;
  }
  try {
    await confirmOperationalAlert(key, claim, now);
  } catch (error) {
    // It was sent; at worst the claim lapses and the owner hears it twice.
    console.warn("[owner-alert] the sent alert could not be recorded", {
      cause: error,
      key,
    });
  }
  return true;
}

/** The condition is over: the next time it happens, the owner hears at once. */
export async function clearOwnerAlert(key: string, now = new Date()) {
  await clearOperationalAlert(key, now);
}

async function sendOwnerMessage(
  botToken: string,
  chatId: string,
  text: string
) {
  const response = await fetch(
    `${telegramApiBaseUrl}/bot${botToken}/sendMessage`,
    {
      body: JSON.stringify({ chat_id: chatId, text }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(requestTimeoutMs),
    }
  );
  // Telegram reports a refused message in the body's `ok`, which a proxy or
  // an edge in between may carry with a 2xx.
  const accepted = telegramReplySchema.safeParse(
    await response.json().catch(() => undefined)
  ).data?.ok;
  if (!response.ok || accepted !== true) {
    throw new Error(
      `Telegram owner alert failed (${String(response.status)}).`
    );
  }
}
