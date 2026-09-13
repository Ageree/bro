/** First-bind onboarding and canned help. Pure: no Convex I/O. */

const HANDLE_RE = /^bro-[a-z0-9]{8}$/;

function cabinetHandle(raw: string | undefined): string | undefined {
  const h = raw?.trim() ?? "";
  return HANDLE_RE.test(h) ? h : undefined;
}

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

/** Public cabinet / vault host. Override with BRO_CABINET_BASE or BRO_PAY_BASE. */
export function cabinetBaseUrl(env: {
  BRO_CABINET_BASE?: string;
  BRO_PAY_BASE?: string;
} = process.env): string {
  const raw =
    env.BRO_CABINET_BASE?.trim() ||
    env.BRO_PAY_BASE?.trim() ||
    "https://brobro.tech";
  return raw.replace(/\/$/, "");
}

/** Same path `vault_setup` / `createVaultSetupUrl` uses for a payment card. */
export function vaultCardUrl(base: string, handle?: string): string {
  const url = new URL("/vault.html", `${base.replace(/\/$/, "")}/`);
  url.searchParams.set("kind", "payment");
  const id = cabinetHandle(handle);
  if (id) url.searchParams.set("handle", id);
  return url.toString();
}

/** Real cabinet login: handle goes in the query so «Уже есть Bro» is prefilled. */
export function cabinetLoginUrl(base: string, handle: string): string {
  const url = new URL("/cabinet.html", `${base.replace(/\/$/, "")}/`);
  const id = cabinetHandle(handle);
  if (id) url.searchParams.set("handle", id);
  return url.toString();
}

export type WelcomeOpts = {
  canJoinGroups?: boolean;
  handle?: string;
  cabinetBase?: string;
};

/** First-contact letter. Same bubbles for a new bind and later «привет».
 *  «Бро.» / «Bro.» as a line opener is only for the rare channel-ok ping. */
export function welcomeBubbles(opts?: WelcomeOpts): string[] {
  void opts?.canJoinGroups;
  const base = opts?.cabinetBase ?? cabinetBaseUrl();
  const handle = cabinetHandle(opts?.handle);
  const vault = vaultCardUrl(base, handle);
  const bubbles = [
    "Привет, я Bro. Я твой личный ассистент.",
    "Могу сам купить на Wildberries и Ozon, записаться к врачу или в салон, забронировать стол. Помню размер, адрес и пункт выдачи. Если попросишь — поставлю напоминание или прослежу за ценой. Когда сайт просит вход, скажи пароль или я пришлю ссылку. Письма приходят на мой ящик, коды ввожу сам. Тот же Bro есть в Telegram — напиши «телеграм». Группы в iMessage пока на паузе, сейчас только личные сообщения.",
    "Пиши как другу — остальное на мне.",
    `Чтобы я мог сам платить в интернете, положи карту в сейф. Открой ссылку и введи её там — номер в чат не пиши.\n${vault}`,
  ];
  if (handle) {
    bubbles.push(
      `Кабинет тоже сразу. Твой Bro — ${handle}. Открой ссылку, нажми «Получить код» — код придёт сюда.\n${cabinetLoginUrl(base, handle)}`,
    );
  } else {
    bubbles.push(
      `Кабинет — на brobro.tech. Открой сайт и нажми «Уже есть Bro», когда появится твой Bro.`,
    );
  }
  return bubbles;
}

export function welcomeText(opts?: WelcomeOpts): string {
  return welcomeBubbles(opts).join("\n\n");
}

export function helpText(opts?: WelcomeOpts): string {
  return welcomeText(opts);
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
