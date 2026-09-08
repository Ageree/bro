import { inlineKeyboard, type TelegramButton } from "./telegram-text.ts";

const API = "https://api.telegram.org";

export type TelegramChatType = "private" | "group" | "supergroup" | "channel";

export type TelegramUser = {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
};

export type TelegramChat = {
  id: number;
  type: TelegramChatType;
};

export type TelegramPhotoSize = {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
};

export type TelegramVoice = {
  file_id: string;
  mime_type?: string;
  file_size?: number;
};

export type TelegramDocument = {
  file_id: string;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
};

export type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  voice?: TelegramVoice;
  audio?: TelegramVoice;
  document?: TelegramDocument;
};

export type TelegramCallbackQuery = {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

function botToken(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN missing");
  return t;
}

export function telegramWebhookSecret(): string | undefined {
  return process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined;
}

export function telegramBotUsername(): string {
  return (process.env.TELEGRAM_BOT_USERNAME ?? "").trim().replace(/^@/, "");
}

export function webhookSecretOk(request: Request): boolean {
  const expected = telegramWebhookSecret();
  if (!expected) return false;
  const got = request.headers.get("x-telegram-bot-api-secret-token");
  return got === expected;
}

/** iOS Telegram ghosts and overlaps cells when several bot messages land
 *  in the same animation frame. Early-deliver flushes fire `void send`, so
 *  without a per-chat gate those POSTs race. */
export const TELEGRAM_SEND_GAP_MS = 280;

type ChatGate = {
  tail: Promise<void>;
  lastAt: number;
};

const chatGates = new Map<string, ChatGate>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resetTelegramSendGateForTests(): void {
  chatGates.clear();
}

export async function enqueueTelegramChat<T>(
  chatId: string | number,
  run: () => Promise<T>,
  opts?: { now?: () => number; gapMs?: number },
): Promise<T> {
  const key = String(chatId);
  const gapMs = opts?.gapMs ?? TELEGRAM_SEND_GAP_MS;
  const clock = opts?.now ?? Date.now;
  const gate = chatGates.get(key) ?? { tail: Promise.resolve(), lastAt: 0 };
  let settle!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const result = new Promise<T>((res, rej) => {
    settle = res;
    reject = rej;
  });
  gate.tail = gate.tail
    .catch(() => undefined)
    .then(async () => {
      const wait = gate.lastAt > 0 ? gate.lastAt + gapMs - clock() : 0;
      if (wait > 0) await sleep(wait);
      try {
        const value = await run();
        gate.lastAt = clock();
        settle(value);
      } catch (err) {
        reject(err);
      }
    })
    .then(
      () => undefined,
      () => undefined,
    );
  chatGates.set(key, gate);
  return result;
}

async function api<T>(
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${API}/bot${botToken()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return readTelegramApi<T>(res, method);
}

async function apiForm<T>(method: string, form: FormData): Promise<T> {
  const res = await fetch(`${API}/bot${botToken()}/${method}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  return readTelegramApi<T>(res, method);
}

async function readTelegramApi<T>(res: Response, method: string): Promise<T> {
  const json = (await res.json()) as { ok?: boolean; description?: string; result?: T };
  if (!res.ok || !json.ok) {
    throw new Error(json.description || `telegram ${method} ${res.status}`);
  }
  return json.result as T;
}

export async function sendTelegramTyping(chatId: string | number): Promise<void> {
  await api("sendChatAction", { chat_id: chatId, action: "typing" });
}

export async function sendTelegramMessage(opts: {
  chatId: string | number;
  html: string;
  buttons?: TelegramButton[][];
  replyTo?: number;
}): Promise<{ message_id: number }> {
  const markup = opts.buttons?.length ? inlineKeyboard(opts.buttons) : undefined;
  return await enqueueTelegramChat(opts.chatId, () =>
    api("sendMessage", {
      chat_id: opts.chatId,
      text: opts.html,
      parse_mode: "HTML",
      disable_web_page_preview: false,
      ...(opts.replyTo ? { reply_to_message_id: opts.replyTo } : {}),
      ...(markup ? { reply_markup: markup } : {}),
    }),
  );
}

export async function sendTelegramPhoto(opts: {
  chatId: string | number;
  url: string;
  html?: string;
  buttons?: TelegramButton[][];
  hasSpoiler?: boolean;
}): Promise<{ message_id: number }> {
  const markup = opts.buttons?.length ? inlineKeyboard(opts.buttons) : undefined;
  return await enqueueTelegramChat(opts.chatId, () =>
    api("sendPhoto", {
      chat_id: opts.chatId,
      photo: opts.url,
      ...(opts.html ? { caption: opts.html.slice(0, 1024), parse_mode: "HTML" } : {}),
      ...(opts.hasSpoiler ? { has_spoiler: true } : {}),
      ...(markup ? { reply_markup: markup } : {}),
    }),
  );
}

export async function sendTelegramPhotoFile(opts: {
  chatId: string | number;
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  html?: string;
  buttons?: TelegramButton[][];
  hasSpoiler?: boolean;
}): Promise<{ message_id: number }> {
  const markup = opts.buttons?.length ? inlineKeyboard(opts.buttons) : undefined;
  return await enqueueTelegramChat(opts.chatId, () => {
    const form = new FormData();
    form.set("chat_id", String(opts.chatId));
    const bytes = new Uint8Array(opts.bytes);
    form.set(
      "photo",
      new File([bytes], opts.filename, { type: opts.contentType }),
    );
    if (opts.html) {
      form.set("caption", opts.html.slice(0, 1024));
      form.set("parse_mode", "HTML");
    }
    if (opts.hasSpoiler) form.set("has_spoiler", "true");
    if (markup) form.set("reply_markup", JSON.stringify(markup));
    return apiForm<{ message_id: number }>("sendPhoto", form);
  });
}

export async function setTelegramReaction(opts: {
  chatId: string | number;
  messageId: number;
  emoji: string;
}): Promise<void> {
  await api("setMessageReaction", {
    chat_id: opts.chatId,
    message_id: opts.messageId,
    reaction: [{ type: "emoji", emoji: opts.emoji }],
  });
}

export async function answerCallback(opts: {
  id: string;
  text?: string;
}): Promise<void> {
  await api("answerCallbackQuery", {
    callback_query_id: opts.id,
    ...(opts.text ? { text: opts.text } : {}),
  });
}

export async function telegramFileUrl(fileId: string): Promise<string> {
  const file = await api<{ file_path?: string }>("getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("telegram file_path missing");
  return `${API}/file/bot${botToken()}/${file.file_path}`;
}

export async function setTelegramWebhook(opts: {
  url: string;
  secret: string;
}): Promise<void> {
  await api("setWebhook", {
    url: opts.url,
    secret_token: opts.secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
}

export function largestPhoto(msg: TelegramMessage): TelegramPhotoSize | undefined {
  const photos = msg.photo ?? [];
  if (photos.length === 0) return undefined;
  return photos.reduce((a, b) => ((b.file_size ?? 0) >= (a.file_size ?? 0) ? b : a));
}

export function isPrivateChat(msg: { chat?: TelegramChat } | undefined): boolean {
  return msg?.chat?.type === "private";
}

export const TELEGRAM_REACTIONS = {
  love: "❤",
  like: "👍",
  dislike: "👎",
  laugh: "😂",
  emphasize: "🔥",
  question: "❓",
  eyes: "👀",
} as const;

export type TelegramReactionName = keyof typeof TELEGRAM_REACTIONS;

export function isTelegramReaction(s: string): s is TelegramReactionName {
  return s in TELEGRAM_REACTIONS;
}
