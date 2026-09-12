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

/** Separate iMessage bubbles. Keep each under ~90 chars.
 *  «Бро.» / «Bro.» as a line opener is only for the rare channel-ok ping,
 *  never for these welcome bubbles. */
export function welcomeBubbles(opts?: { canJoinGroups?: boolean }): string[] {
  void opts?.canJoinGroups;
  return [
    "Если нужно купить, записаться или напомнить — пиши как другу, сделаю сам.",
    "Карту в чат не кидай: она лежит в сейфе. Группы в iMessage пока на паузе.",
    "Если интересно, что ещё умею — напиши «что ты умеешь».",
  ];
}

export function welcomeText(opts?: { canJoinGroups?: boolean }): string {
  return welcomeBubbles(opts).join("\n\n");
}

export function helpText(opts?: { canJoinGroups?: boolean }): string {
  void opts?.canJoinGroups;
  return [
    "Могу сам купить на Wildberries и Ozon, записаться к врачу или в салон, забронировать стол.",
    "",
    "Помню размер, адрес и ПВЗ. Напоминания и сторожа тоже на мне. Плачу из сейфа — номер карты в чат не пиши. Если сайт просит вход, скажи пароль или я пришлю ссылку.",
    "",
    "Письма приходят на мой ящик, коды ввожу сам. Тот же Bro есть в Telegram — напиши «телеграм». Группы в iMessage пока на паузе, сейчас только личка.",
    "",
    "Пиши как другу.",
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
