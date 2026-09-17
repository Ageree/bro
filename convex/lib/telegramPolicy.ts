/** Telegram is a second channel on an existing iMessage tenant.
 *  Same phone, mailbox, Composio, eve session. Bind via one-time /start token. */

export const TELEGRAM_BIND_TTL_MS = 30 * 60 * 1000;
export const TELEGRAM_START_PREFIX = "bind_";

export type HumanChannel = "imessage" | "telegram";

export type TelegramBindKind =
  | "ok"
  | "expired"
  | "unknown_token"
  | "unbound_phone"
  | "already_other_user"
  | "already_other_tenant";

export function newTelegramBindToken(
  random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(16)),
): string {
  return [...random()].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function telegramBindExpiry(
  now: number,
  ttlMs = TELEGRAM_BIND_TTL_MS,
): number {
  return now + ttlMs;
}

export function telegramStartPayload(token: string): string {
  return `${TELEGRAM_START_PREFIX}${token}`;
}

export function telegramBindLink(botUsername: string, token: string): string {
  const user = botUsername.trim().replace(/^@/, "");
  return `https://t.me/${user}?start=${telegramStartPayload(token)}`;
}

/** `/start`, `/start bind_ab12…`, or the payload alone. */
export function parseTelegramStart(text: string): {
  command: true;
  token: string | null;
} | null {
  const raw = text.replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const m = raw.match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?$/i);
  if (m) {
    return { command: true, token: normalizeStartToken(m[1]) };
  }
  if (/^bind_[a-f0-9]{32}$/i.test(raw)) {
    return { command: true, token: raw.slice(TELEGRAM_START_PREFIX.length).toLowerCase() };
  }
  return null;
}

function normalizeStartToken(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (/^bind_[a-f0-9]{32}$/i.test(t)) {
    return t.slice(TELEGRAM_START_PREFIX.length).toLowerCase();
  }
  if (/^[a-f0-9]{32}$/i.test(t)) return t.toLowerCase();
  return null;
}

export function bindTelegramDecision(opts: {
  now: number;
  tokenFound: boolean;
  expiresAt?: number;
  tenantPhone?: string;
  tenantTelegramUserId?: string;
  incomingUserId: string;
  otherTenantPhone?: string;
}): TelegramBindKind {
  if (!opts.tokenFound) return "unknown_token";
  if (opts.expiresAt !== undefined && opts.now >= opts.expiresAt) return "expired";
  if (!opts.tenantPhone) return "unbound_phone";
  if (opts.otherTenantPhone && opts.otherTenantPhone !== opts.tenantPhone) {
    return "already_other_tenant";
  }
  if (
    opts.tenantTelegramUserId &&
    opts.tenantTelegramUserId !== opts.incomingUserId
  ) {
    return "already_other_user";
  }
  return "ok";
}

export function lastChannelOf(raw: string | null | undefined): HumanChannel {
  return raw === "telegram" ? "telegram" : "imessage";
}

export function canDeliverTelegram(chatId: string | null | undefined): boolean {
  return typeof chatId === "string" && chatId.length > 0;
}

export function bindRefuseText(kind: TelegramBindKind): string {
  switch (kind) {
    case "expired":
      return "Ссылка устарела. Напиши Bro в iMessage «телеграм» — пришлю новую.";
    case "unknown_token":
      return "Bro в Telegram — второй канал того же агента. Ссылка приходит из iMessage: напиши там «телеграм».";
    case "unbound_phone":
      return "Сначала напиши Bro в iMessage, потом открой ссылку ещё раз.";
    case "already_other_user":
      return "Этот Bro уже привязан к другому Telegram.";
    case "already_other_tenant":
      return "Этот Telegram уже привязан к другому Bro.";
    default:
      return "Не получилось подключить Telegram.";
  }
}

export const TELEGRAM_WEBHOOK_PATH = "/webhooks/telegram";

/** The one URL Telegram must be pointed at, for a given deployment origin. */
export function telegramWebhookUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${TELEGRAM_WEBHOOK_PATH}`;
}

/**
 * What the deployment and Telegram itself say about this bot.
 *
 * Every field is a fact read at one moment, never a judgement: `telegramHealth`
 * turns them into one. Secrets are present/absent booleans — the bot token and
 * the webhook secret never leave the deployment, and a username is public
 * anyway (it is the `t.me/<bot>` link).
 */
export type TelegramHealthFacts = {
  /** Origin the deployment serves on, from `publicOrigin()`. */
  origin: string;
  hasToken: boolean;
  /** `TELEGRAM_BOT_USERNAME` as configured, without the `@`. */
  configuredUsername: string;
  hasWebhookSecret: boolean;
  /**
   * Whether `hasWebhookSecret` was read where the secret lives.
   *
   * False from an operator's machine: the deployment's copy is the one Telegram
   * is checked against, and a laptop that lacks it proves nothing. Absent or
   * true means the answer counts.
   */
  webhookSecretVisible?: boolean;
  /** Username Telegram reports for this token (`getMe`). */
  botUsername?: string;
  /** `getMe` refused — a wrong or revoked token. */
  tokenError?: string;
  /** Where Telegram currently posts updates (`getWebhookInfo`); "" means nowhere. */
  webhookUrl?: string;
  webhookError?: string;
  pendingUpdates?: number;
  lastErrorMessage?: string;
};

export type TelegramHealth = {
  /** The whole chain works: link can be minted, updates arrive, sends go out. */
  ok: boolean;
  /** No Telegram configured at all. A deployment's choice, not a fault. */
  off: boolean;
  /** One line per broken link in the chain, operator-facing. */
  problems: string[];
  /** Set when re-pointing the webhook at `expectedWebhookUrl` would help. */
  webhookDrifted: boolean;
  expectedWebhookUrl: string;
};

/**
 * Verdict on the Telegram chain, from facts alone.
 *
 * This exists because every way Telegram dies in production is invisible to
 * this repository: the bot token, the username and the webhook secret live on
 * the deployment, and where Telegram posts updates lives at Telegram. A
 * missing `TELEGRAM_BOT_USERNAME` tells every person who asks that the channel
 * is off; a missing `TELEGRAM_WEBHOOK_SECRET` makes `webhookSecretOk` reject
 * every update, so the bot goes deaf with a 401 nobody reads; and the webhook
 * URL is set once by hand (`npm run telegram:webhooks`), so it keeps pointing
 * at whatever host was live that day. None of it shows up in a unit check.
 */
export function telegramHealth(facts: TelegramHealthFacts): TelegramHealth {
  const expectedWebhookUrl = telegramWebhookUrl(facts.origin);
  const username = facts.configuredUsername.trim().replace(/^@/, "");
  const webhookUrl = (facts.webhookUrl ?? "").trim();
  const problems: string[] = [];

  if (!facts.hasToken && !username) {
    return {
      ok: false,
      off: true,
      problems: ["no Telegram on this deployment: TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME are both unset"],
      webhookDrifted: false,
      expectedWebhookUrl,
    };
  }

  if (!facts.hasToken) {
    problems.push("TELEGRAM_BOT_TOKEN is not set: nothing can be sent to Telegram");
  }
  if (facts.tokenError) {
    problems.push(`Telegram refused TELEGRAM_BOT_TOKEN: ${facts.tokenError}`);
  }
  if (!username) {
    problems.push(
      "TELEGRAM_BOT_USERNAME is not set: there is no t.me link to mint, so «телеграм» answers «Telegram у Bro ещё не включён»",
    );
  } else if (facts.botUsername && facts.botUsername.toLowerCase() !== username.toLowerCase()) {
    problems.push(
      `TELEGRAM_BOT_USERNAME is @${username} but the token belongs to @${facts.botUsername}: every bind link points at the wrong bot`,
    );
  }
  if (!facts.hasWebhookSecret && facts.webhookSecretVisible !== false) {
    problems.push(
      "TELEGRAM_WEBHOOK_SECRET is not set: webhookSecretOk rejects every update with 401, so the bot never hears anything",
    );
  }
  if (facts.webhookError) {
    problems.push(`could not read the webhook from Telegram: ${facts.webhookError}`);
  }

  const webhookDrifted = Boolean(facts.hasToken) && !facts.tokenError && !facts.webhookError && webhookUrl !== expectedWebhookUrl;
  if (webhookDrifted) {
    problems.push(
      webhookUrl
        ? `Telegram posts updates to ${webhookUrl}, not ${expectedWebhookUrl}: messages in Telegram reach a host that is not this deployment`
        : `Telegram has no webhook set: it should be ${expectedWebhookUrl}`,
    );
  }
  if (facts.lastErrorMessage) {
    problems.push(`Telegram's last delivery attempt failed: ${facts.lastErrorMessage}`);
  }
  const pending = facts.pendingUpdates ?? 0;
  if (pending > 10) {
    problems.push(`${pending} updates are queued at Telegram undelivered`);
  }

  return {
    ok: problems.length === 0,
    off: false,
    problems,
    webhookDrifted,
    expectedWebhookUrl,
  };
}

export function telegramWelcomeText(): string {
  return [
    "Тот же Bro, что в iMessage.",
    "",
    "Почта и поручения общие — пиши сюда.",
  ].join("\n");
}
