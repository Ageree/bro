import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bindRefuseText,
  bindTelegramDecision,
  canDeliverTelegram,
  lastChannelOf,
  newTelegramBindToken,
  parseTelegramStart,
  telegramBindExpiry,
  telegramBindLink,
  telegramStartPayload,
  telegramWelcomeText,
} from "../convex/lib/telegramPolicy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const bytes = new Uint8Array(16).fill(0xab);
assert(
  newTelegramBindToken(() => bytes) === "ab".repeat(16),
  "token hex",
);

const token = "a".repeat(32);
assert(telegramStartPayload(token) === `bind_${token}`, "start payload");
assert(
  telegramBindLink("@BroConciergeBot", token) ===
    `https://t.me/BroConciergeBot?start=bind_${token}`,
  "deep link strips @",
);
assert(telegramBindExpiry(1_000, 500) === 1_500, "expiry");

assert(parseTelegramStart("/start")?.token === null, "bare start");
assert(parseTelegramStart("/start@BroBot")?.token === null, "start at bot");
assert(
  parseTelegramStart(`/start bind_${token}`)?.token === token,
  "start bind token",
);
assert(parseTelegramStart(`/start ${token}`)?.token === token, "start raw token");
assert(parseTelegramStart(`bind_${token}`)?.token === token, "payload alone");
assert(parseTelegramStart("купи молоко") === null, "not a start");
assert(parseTelegramStart("/help") === null, "help is not start");

const now = 10_000;
assert(
  bindTelegramDecision({
    now,
    tokenFound: false,
    incomingUserId: "1",
  }) === "unknown_token",
  "missing token",
);
assert(
  bindTelegramDecision({
    now,
    tokenFound: true,
    expiresAt: now,
    incomingUserId: "1",
    tenantPhone: "+7999",
  }) === "expired",
  "expired inclusive",
);
assert(
  bindTelegramDecision({
    now,
    tokenFound: true,
    expiresAt: now + 1,
    incomingUserId: "1",
  }) === "unbound_phone",
  "no phone yet",
);
assert(
  bindTelegramDecision({
    now,
    tokenFound: true,
    expiresAt: now + 1,
    incomingUserId: "1",
    tenantPhone: "+7999",
    otherTenantPhone: "+7888",
  }) === "already_other_tenant",
  "tg user owned elsewhere",
);
assert(
  bindTelegramDecision({
    now,
    tokenFound: true,
    expiresAt: now + 1,
    incomingUserId: "1",
    tenantPhone: "+7999",
    tenantTelegramUserId: "2",
  }) === "already_other_user",
  "tenant already linked",
);
assert(
  bindTelegramDecision({
    now,
    tokenFound: true,
    expiresAt: now + 1,
    incomingUserId: "1",
    tenantPhone: "+7999",
    tenantTelegramUserId: "1",
  }) === "ok",
  "same user rebind",
);
assert(
  bindTelegramDecision({
    now,
    tokenFound: true,
    expiresAt: now + 1,
    incomingUserId: "1",
    tenantPhone: "+7999",
  }) === "ok",
  "fresh bind",
);

assert(lastChannelOf("telegram") === "telegram", "tg channel");
assert(lastChannelOf("imessage") === "imessage", "imessage channel");
assert(lastChannelOf(undefined) === "imessage", "default channel");
assert(canDeliverTelegram("99"), "has chat");
assert(!canDeliverTelegram(""), "empty chat");
assert(bindRefuseText("unknown_token").includes("iMessage"), "refuse mentions iMessage");
assert(telegramWelcomeText().includes("iMessage"), "welcome same agent");

const telegramWebhook = readFileSync(
  resolve(import.meta.dirname, "../agent/lib/telegram-webhook.ts"),
  "utf8",
);
assert(
  telegramWebhook.includes('authenticator: "inkbox"') &&
    telegramWebhook.includes("from(opts.conversationId).send"),
  "telegram steers the iMessage eve session",
);
assert(
  telegramWebhook.includes("waitUntil") &&
    telegramWebhook.includes("steerBroTurn(from"),
  "telegram starts the turn without blocking the webhook",
);
const imessageChannel = readFileSync(
  resolve(import.meta.dirname, "../agent/channels/imessage.ts"),
  "utf8",
);
assert(
  imessageChannel.includes('POST("/webhooks/telegram"'),
  "telegram HTTP is on the iMessage channel",
);

console.log("telegram-policy-check ok");
