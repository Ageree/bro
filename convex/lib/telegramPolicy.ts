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

export function telegramWelcomeText(): string {
  return [
    "Это тот же Bro, что в iMessage.",
    "",
    "Почта, напоминания и поручения общие. Пиши сюда, если так удобнее — отвечу здесь.",
  ].join("\n");
}
