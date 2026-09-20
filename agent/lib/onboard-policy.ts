/** First-bind onboarding and canned help. Pure: no Convex I/O. */

const HANDLE_RE = /^bro-[a-z0-9]{8}$/;

function cabinetHandle(raw: string | undefined): string | undefined {
  const h = raw?.trim() ?? "";
  return HANDLE_RE.test(h) ? h : undefined;
}

const VOICE_PREFIX = /^\[voice\]\s*/i;

/** A bare hello. Worth the whole letter once, on the first bind; after that it
 *  is just a human saying hi and the agent answers it like any other line. */
const GREETING_EXACT = new Set([
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
]);

/** An explicit ask for the letter. Always answered with the letter. */
const HELP_EXACT = new Set([
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

/** Words that name the channel itself, in the forms people actually type. */
const TELEGRAM_WORDS = new Set([
  "телеграм", "телеграма", "телеграме", "телеграму", "телеграмом",
  "телеграмм", "телеграмма", "телеграмме", "телеграмму", "телеграммом",
  "телега", "телеге", "телеги", "телегу",
  "тг", "telegram", "tg",
]);

/**
 * Everything else a bare «есть телеграм?» is allowed to be made of.
 *
 * The gate used to be four exact strings, so «а в телеграме с тобой можно
 * пообщаться?» fell through to a full agent turn — and the agent has no tool
 * that mints a `t.me` bind link and nothing in its instructions about the
 * second channel beyond formatting, so it answered that Telegram is not
 * available. It is; the link just only ever came from this canned lane.
 *
 * A closed vocabulary rather than a keyword sniff: the message must be about
 * the channel and NOTHING else. One unknown word — a name, an item, a verb
 * like «напиши» — and this is an errand that merely mentions Telegram, which
 * belongs to the agent. That is why «телеграмму напиши» still misses.
 */
const TELEGRAM_ASK_WORDS = new Set([
  // question scaffolding
  "а", "и", "ну", "же", "ли", "еще", "вообще", "там", "тут", "сейчас",
  "сегодня", "точно", "правда", "что", "как", "где", "почему", "разве",
  "не", "нет", "или", "пока", "уже", "теперь", "когда", "скоро", "давно",
  // is it on / does it work
  "есть", "был", "была", "будет", "бывает", "появился", "появится",
  "включен", "включена", "включено", "доступен", "доступна", "доступно",
  "работает", "работаешь", "работают", "живой", "жив", "сидишь",
  "поддерживаешь", "поддерживается", "умеешь", "можешь", "можно", "могу",
  // give me the link / I want to chat there
  "хочу", "хотел", "хотела", "давай", "дай", "дашь", "скинь", "скинешь",
  "пришли", "пришлешь", "кинь", "ссылку", "ссылка", "ссылки", "линк",
  "бот", "бота", "боте", "чат", "чате", "чатик", "канал", "версия",
  "версию", "версии", "вариант", "общаться", "пообщаться", "поговорить",
  "переписываться", "писать", "написать", "пользоваться", "перейти",
  "зайти", "добавить", "пожалуйста", "плиз",
  // pronouns, prepositions, filler
  "ты", "тебя", "тебе", "тобой", "тобою", "твой", "твоя", "я", "меня",
  "мне", "мы", "нам", "в", "во", "на", "с", "со", "у", "к", "по", "про",
  "тоже", "также", "бро", "bro",
  // openers: people say hello and think aloud before the question
  "привет", "здорово", "слушай", "смотри", "кстати", "короче", "ок", "окей",
]);

/** A bare ask for the second channel: «телеграм», «есть тг?», «а в телеграме
 *  с тобой можно пообщаться?». Answered with a `t.me` bind link, not a turn. */
export function isTelegramAsk(text: string): boolean {
  const folded = foldAsk(text);
  if (!folded) return false;
  if (TELEGRAM_ASK.has(folded)) return true;
  // No length cap. There was one — eight words — and it is what let the very
  // message this lane was widened for slip through: «Бро а с тобой же можно
  // общаться в тг?» is nine, every one of them in the vocabulary below, and
  // the cap threw it to the agent, which answered «телегу ещё не подрубили».
  // A cap adds nothing a closed vocabulary does not already do: a long message
  // built only of these words is still a question about the channel and
  // nothing else, and one word outside them stops it at any length.
  let named = false;
  for (const word of folded.split(" ")) {
    if (TELEGRAM_WORDS.has(word)) {
      named = true;
      continue;
    }
    if (!TELEGRAM_ASK_WORDS.has(word)) return false;
  }
  return named;
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

export function isGreeting(text: string): boolean {
  const folded = foldAsk(text);
  if (!folded) return false;
  return GREETING_EXACT.has(folded);
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

/** The letter goes out once, on the first bind, and after that only when a human
 *  asks for it by name («что ты», «help», «помощь»). A later «привет» is a
 *  normal turn — the agent greets back instead of resending five bubbles. */
export function shouldSendWelcome(input: {
  firstBind: boolean;
  text: string;
}): boolean {
  if (input.firstBind) return true;
  return isHelpAsk(input.text);
}

export function shouldSkipAgentTurn(input: {
  firstBind: boolean;
  text: string;
}): boolean {
  if (isHelpAsk(input.text)) return true;
  if (isTelegramAsk(input.text)) return true;
  if (!input.firstBind) return false;
  return isGreeting(input.text) || isConnectOrEmptyInbound(input.text);
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

/** Payment-card vault. New copy never puts a handle in the URL.
 *  `handle` is only for old `?handle=` fallbacks. */
export function vaultCardUrl(base: string, handle?: string): string {
  const url = new URL("/vault.html", `${base.replace(/\/$/, "")}/`);
  url.searchParams.set("kind", "payment");
  const id = cabinetHandle(handle);
  if (id) url.searchParams.set("handle", id);
  return url.toString();
}

/** Cabinet login. New copy is handle-free; `handle` stays as a fallback. */
export function cabinetLoginUrl(base: string, handle?: string): string {
  const url = new URL("/cabinet.html", `${base.replace(/\/$/, "")}/`);
  const id = cabinetHandle(handle);
  if (id) url.searchParams.set("handle", id);
  return url.toString();
}

export type WelcomeOpts = {
  handle?: string;
  cabinetBase?: string;
};

/** First-contact letter. Sent on the first bind, and later only for an explicit
 *  «что ты» / «help» / «помощь» — never again for a plain «привет».
 *  «Бро.» / «Bro.» as a line opener is only for the rare channel-ok ping. */
export function welcomeBubbles(opts?: WelcomeOpts): string[] {
  void opts?.handle;
  const base = opts?.cabinetBase ?? cabinetBaseUrl();
  const vault = vaultCardUrl(base);
  const cabinet = cabinetLoginUrl(base);
  return [
    "Привет, я Bro. Делаю за тебя скучные дела в интернете.",
    "Закажу на Wildberries или Ozon, запишу к врачу или в салон, забронирую стол. Размер, адрес и пункт выдачи помню — второй раз не спрошу.",
    "Надо — напомню о чём-нибудь или послежу за ценой, пока не упадёт.",
    "Если сайт просит вход, возьму его из сейфа или пришлю ссылку, и ты зайдёшь сам. Пароль в чат не пиши, он мне не нужен. Письма и коды приходят на мой ящик, дальше я сам.",
    "Я ещё в телеграме, тот же самый — напиши «телеграм», скину. Пиши как другу, остальное на мне.",
    `Хочешь, чтобы я платил сам — положи карту в сейф. Открой ссылку, введи телефон, с которого мне пишешь, и код, который придёт сюда. Номер карты в чат не пиши.\n${vault}`,
    `Кабинет — вход такой же, телефон и код.\n${cabinet}`,
  ];
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
