/** First-bind onboarding and canned help. Pure: no Convex, no Inkbox client. */

const VOICE_PREFIX = /^\[voice\]\s*/i;

const HELP_EXACT = new Set([
  "привет",
  "привет бро",
  "привет bro",
  "здарова",
  "здарова бро",
  "здарова bro",
  "hello",
  "hello bro",
  "hi",
  "hi bro",
  "что ты",
  "кто ты",
  "что умеешь",
  "что ты умеешь",
  "help",
  "/help",
  "помощь",
]);

function visibleInbound(text: string): string {
  return text.replace(VOICE_PREFIX, "").trim();
}

const TELEGRAM_ASK = new Set(["телеграм", "telegram", "тг", "/telegram"]);

export function isTelegramAsk(text: string): boolean {
  const folded = foldAsk(text);
  return TELEGRAM_ASK.has(folded);
}

export function foldAsk(text: string): string {
  return visibleInbound(text)
    .normalize("NFC")
    .replace(/ё/gi, "е")
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/[^\p{L}\p{N}/@\s+-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isHelpAsk(text: string): boolean {
  const folded = foldAsk(text);
  if (!folded) return false;
  if (HELP_EXACT.has(folded)) return true;
  return /^(?:что|кто) ты(?: (?:такое|такой|умеешь))?$/.test(folded);
}

export function isConnectOrEmptyInbound(text: string): boolean {
  const visible = visibleInbound(text);
  const compact = visible.replace(/\s+/g, " ").trim();
  if (!compact) return true;
  return /^connect\s+@[a-z0-9][a-z0-9._-]*$/i.test(compact);
}

export function shouldSkipAgentTurn(input: {
  firstBind: boolean;
  text: string;
}): boolean {
  if (isHelpAsk(input.text)) return true;
  if (isTelegramAsk(input.text)) return true;
  if (input.firstBind && isConnectOrEmptyInbound(input.text)) return true;
  return false;
}

/** Separate iMessage bubbles. Keep each under ~90 chars. */
export function welcomeBubbles(opts?: { canJoinGroups?: boolean }): string[] {
  void opts?.canJoinGroups;
  return [
    "Bro. Купить, записать, напомнить — пиши как другу. Сделаю сам.",
    "Карту в чат не кидай, она в сейфе. Группы в iMessage пока на паузе.",
    "Список — «что ты умеешь».",
  ];
}

export function welcomeText(opts?: { canJoinGroups?: boolean }): string {
  return welcomeBubbles(opts).join("\n\n");
}

export function helpText(opts?: { canJoinGroups?: boolean }): string {
  void opts?.canJoinGroups;
  return [
    "Умею:",
    "",
    "• Купить на Wildberries и Ozon",
    "• Запись к врачу, салон, бронь",
    "• Помнить размер, адрес, ПВЗ",
    "• Напоминания и сторожа",
    "• Платить из сейфа — номер в чат не пиши",
    "• Войти на сайт — пароль скажи, или кину ссылку",
    "• Письма со своего ящика — коды сам",
    "• Тот же Bro в Telegram — «телеграм»",
    "• Группы: после Photon Business. Сейчас только личка.",
    "",
    "Пиши текстом.",
  ].join("\n");
}

function escapeVcardText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function emailLine(email: string | undefined): string | undefined {
  const raw = email?.trim();
  if (!raw || /\s/.test(raw) || !raw.includes("@")) return undefined;
  return `EMAIL:${escapeVcardText(raw)}`;
}

function telLine(tel: string | undefined): string | undefined {
  const raw = tel?.trim();
  if (!raw) return undefined;
  const compact = raw.replace(/[\s()-]/g, "");
  if (!/^\+?[0-9]{8,16}$/.test(compact)) return undefined;
  const e164 = compact.startsWith("+") ? compact : `+${compact}`;
  return `TEL;VALUE=uri:${escapeVcardText(`tel:${e164}`)}`;
}

/** Tiny RFC 6350 vCard. FN/N are Bro; EMAIL/TEL only when valid. */
export function broVcard(opts: { email?: string; tel?: string }): string {
  const lines = ["BEGIN:VCARD", "VERSION:4.0", "FN:Bro", "N:Bro;;;;"];
  const email = emailLine(opts.email);
  if (email) lines.push(email);
  const tel = telLine(opts.tel);
  if (tel) lines.push(tel);
  lines.push("END:VCARD");
  return `${lines.join("\r\n")}\r\n`;
}
