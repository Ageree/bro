import {
  bindRefuseText,
  bindTelegramDecision,
  canDeliverTelegram,
  lastChannelOf,
  newTelegramBindToken,
  parseTelegramStart,
  telegramBindExpiry,
  telegramBindLink,
  telegramHealth,
  telegramStartPayload,
  telegramWebhookUrl,
  telegramWelcomeText,
  type TelegramHealthFacts,
} from "../convex/lib/telegramPolicy.ts";

import { assert, src, withEnv } from "./lib/check.ts";
import { secretEquals } from "../agent/lib/secret-compare.ts";
import { webhookSecretOk } from "../agent/lib/telegram.ts";

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
assert(telegramWelcomeText().length < 120, "telegram welcome stays short");

// secretEquals tests
assert(secretEquals("abc", "abc"), "equal strings");
assert(!secretEquals("abc", "abd"), "different same-length strings");
assert(!secretEquals("ab", "abc"), "different length strings");
assert(!secretEquals(undefined, "abc"), "undefined got");
assert(!secretEquals(123 as unknown, "abc"), "non-string got");
assert(!secretEquals("abc", ""), "empty expected");
assert(!secretEquals("abc", undefined), "undefined expected");

// webhookSecretOk tests
withEnv({ TELEGRAM_WEBHOOK_SECRET: "abc" }, () => {
  const req = new Request("https://x", {
    headers: { "x-telegram-bot-api-secret-token": "abc" },
  });
  assert(webhookSecretOk(req), "valid webhook secret");
});

withEnv({ TELEGRAM_WEBHOOK_SECRET: "abc" }, () => {
  const req = new Request("https://x", {
    headers: { "x-telegram-bot-api-secret-token": "abd" },
  });
  assert(!webhookSecretOk(req), "invalid webhook secret");
});

// --- health verdict: every way the second channel dies in production ---
//
// The incident: people asked Bro about Telegram and were told it is not
// available. The ask itself is fixed in `onboard-policy`, but the chain behind
// it lives outside this repository — three env vars on the deployment and one
// URL at Telegram — so the verdict that reads those facts is what has to be
// worth trusting. One case per broken link.
const HEALTHY: TelegramHealthFacts = {
  origin: "https://bro-agent.vercel.app",
  hasToken: true,
  configuredUsername: "BroConciergeBot",
  hasWebhookSecret: true,
  botUsername: "BroConciergeBot",
  webhookUrl: "https://bro-agent.vercel.app/webhooks/telegram",
  pendingUpdates: 0,
};

assert(
  telegramWebhookUrl("https://bro-agent.vercel.app/") ===
    "https://bro-agent.vercel.app/webhooks/telegram",
  "webhook url is one path on the origin, trailing slash or not",
);

{
  const health = telegramHealth(HEALTHY);
  assert(health.ok && !health.off, "a configured, pointed bot is healthy");
  assert(health.problems.length === 0, "a healthy chain reports no problem");
  assert(!health.webhookDrifted, "a matching webhook has not drifted");
}

{
  const health = telegramHealth({
    ...HEALTHY,
    hasToken: false,
    configuredUsername: "",
    hasWebhookSecret: false,
    botUsername: undefined,
    webhookUrl: undefined,
    pendingUpdates: undefined,
  });
  assert(health.off, "no token and no username is «no telegram here», not a fault");
  assert(!health.ok, "«off» is still not ok");
  assert(!health.webhookDrifted, "nothing to re-point when there is no token");
}

{
  // The exact production state that answers «Telegram у Bro ещё не включён».
  const health = telegramHealth({ ...HEALTHY, configuredUsername: "" });
  assert(!health.ok && !health.off, "a token without a username is broken, not off");
  assert(
    health.problems.some((p) => p.includes("TELEGRAM_BOT_USERNAME")),
    "a missing username is named as the problem",
  );
}

{
  // The deaf bot: Telegram posts, `webhookSecretOk` answers 401, nobody knows.
  const health = telegramHealth({ ...HEALTHY, hasWebhookSecret: false });
  assert(!health.ok, "no webhook secret is broken");
  assert(
    health.problems.some((p) => p.includes("TELEGRAM_WEBHOOK_SECRET")),
    "a missing webhook secret is named as the problem",
  );
}

{
  // Local mode reads the secret off the operator's machine, where its absence
  // means nothing: the deployment's copy is the one Telegram is checked
  // against. A false «broken» there would teach the reader to ignore the tool.
  const health = telegramHealth({
    ...HEALTHY,
    hasWebhookSecret: false,
    webhookSecretVisible: false,
  });
  assert(health.ok, "a secret we cannot see from here is not a problem");
}

{
  // The link points at a bot this token cannot answer for.
  const health = telegramHealth({ ...HEALTHY, botUsername: "SomeOtherBot" });
  assert(!health.ok, "a username/token mismatch is broken");
  assert(
    health.problems.some((p) => p.includes("@SomeOtherBot")),
    "the mismatch names the bot the token really belongs to",
  );
}

{
  // The drift this check exists for: webhook still on last month's host.
  const health = telegramHealth({
    ...HEALTHY,
    webhookUrl: "https://bro-agent-old-deployment.vercel.app/webhooks/telegram",
  });
  assert(!health.ok && health.webhookDrifted, "a webhook on another host has drifted");
  assert(
    health.expectedWebhookUrl === "https://bro-agent.vercel.app/webhooks/telegram",
    "the verdict carries the URL to re-point to",
  );
}

{
  const health = telegramHealth({ ...HEALTHY, webhookUrl: "" });
  assert(health.webhookDrifted, "no webhook at all counts as drifted");
  assert(
    health.problems.some((p) => p.includes("no webhook set")),
    "an unset webhook says so",
  );
}

{
  const health = telegramHealth({
    ...HEALTHY,
    pendingUpdates: 42,
    lastErrorMessage: "Wrong response from the webhook: 401 Unauthorized",
  });
  assert(!health.ok, "telegram's own delivery error is a problem");
  assert(
    health.problems.some((p) => p.includes("401")) &&
      health.problems.some((p) => p.includes("42")),
    "both the error and the queue depth are reported",
  );
  assert(!health.webhookDrifted, "a right URL that errors has not drifted");
}

{
  // A queue can be briefly non-empty on a healthy bot; that is not a fault.
  const health = telegramHealth({ ...HEALTHY, pendingUpdates: 3 });
  assert(health.ok, "a few in-flight updates are not a problem");
}

{
  const health = telegramHealth({ ...HEALTHY, tokenError: "Unauthorized" });
  assert(!health.ok, "a token Telegram refuses is broken");
  assert(!health.webhookDrifted, "a refused token cannot be trusted about the webhook");
}

const healthScript = src("scripts/telegram-health.ts");
assert(
  healthScript.includes("/internal/telegram-health"),
  "the health script asks the deployment, where the variables actually live",
);
assert(
  src("scripts/deploy.sh").includes("scripts/telegram-health.ts"),
  "deploy.sh verifies telegram after deploying, like it verifies /l",
);
assert(
  src("package.json").includes('"telegram:health"'),
  "package.json exposes telegram:health",
);

console.log("telegram-policy-check ok");
