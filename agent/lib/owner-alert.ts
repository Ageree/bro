import {
  claimOperationalAlert,
  clearOperationalAlert,
} from "@db/services/operational-alerts";
import { env } from "@shared/environment";

const telegramApiBaseUrl = "https://api.telegram.org";
const requestTimeoutMs = 10_000;

/**
 * Tell the deployment's owner, in their Telegram chat, about a condition only
 * they can fix: a balance to top up, reports that are not reaching people.
 * What was already said lives in `operational_alerts`, so two ticks that see
 * the same condition cannot both send, and the alert repeats only once
 * `repeatAfterMs` has passed or the value fell to half. An alert nobody
 * received is forgotten at once, so the next tick tries again. False when
 * nothing was sent: no owner chat is configured, or it was already said.
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
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const ownerChatId = env.TELEGRAM_OWNER_CHAT_ID;
  if (!botToken || !ownerChatId) return false;
  const now = options.now ?? new Date();
  const claimed = await claimOperationalAlert(key, options.value ?? 0, {
    // Without a drop that counts, only time repeats the alert.
    minimumDrop: options.minimumDrop ?? Number.MAX_SAFE_INTEGER,
    now,
    repeatAfterMs: options.repeatAfterMs,
  });
  if (!claimed) return false;
  try {
    await sendOwnerMessage(botToken, ownerChatId, text);
    return true;
  } catch (error) {
    await clearOperationalAlert(key, now);
    throw error;
  }
}

/** The condition is over: the next time it happens, the owner hears at once. */
export async function clearOwnerAlert(key: string, now = new Date()) {
  await clearOperationalAlert(key, now);
}

async function sendOwnerMessage(
  botToken: string,
  ownerChatId: string,
  text: string
) {
  const response = await fetch(
    `${telegramApiBaseUrl}/bot${botToken}/sendMessage`,
    {
      body: JSON.stringify({ chat_id: ownerChatId, text }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(requestTimeoutMs),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Telegram owner alert failed (${String(response.status)}).`
    );
  }
}
