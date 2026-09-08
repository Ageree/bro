import { stripConnectUrls } from "../agent/lib/connect-link.ts";
import { toIMessageText } from "../agent/lib/imessage-text.ts";
import {
  compileTelegram,
  escapeHtml,
  extractButtons,
  splitTelegramHtml,
  toTelegramHtml,
} from "../agent/lib/telegram-text.ts";
import {
  enqueueTelegramChat,
  isTelegramReaction,
  resetTelegramSendGateForTests,
  TELEGRAM_REACTIONS,
  TELEGRAM_SEND_GAP_MS,
} from "../agent/lib/telegram.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(escapeHtml("a<b&c>") === "a&lt;b&amp;c&gt;", "escape");
assert(toTelegramHtml("просто текст") === "просто текст", "plain");
assert(toTelegramHtml("**привет**") === "<b>привет</b>", "cyrillic bold");
assert(toTelegramHtml("*курс*") === "<i>курс</i>", "cyrillic italic");
assert(toTelegramHtml("~~нет~~") === "<s>нет</s>", "strike");
assert(toTelegramHtml("`code`") === "<code>code</code>", "code");
assert(
  toTelegramHtml("[Почта](https://mail.google.com/x)") ===
    '<a href="https://mail.google.com/x">Почта</a>',
  "link",
);
assert(toTelegramHtml("# Заголовок") === "<b>Заголовок</b>", "heading");
assert(
  toTelegramHtml("> цитата") === "<blockquote>цитата</blockquote>",
  "quote",
);
assert(
  toTelegramHtml("> строка один\n> строка два") ===
    "<blockquote>строка один\nстрока два</blockquote>",
  "multiline quote merges",
);
assert(
  toTelegramHtml(">! секрет\n>! ещё") ===
    "<blockquote expandable>секрет\nещё</blockquote>",
  "expandable quote",
);
assert(
  toTelegramHtml("> скрыто||") ===
    "<blockquote expandable>скрыто</blockquote>",
  "expandable via trailing ||",
);
assert(toTelegramHtml("++черта++") === "<u>черта</u>", "underline");
assert(
  toTelegramHtml("||спойлер||") === "<tg-spoiler>спойлер</tg-spoiler>",
  "spoiler",
);
assert(toTelegramHtml("- один") === "• один", "ul");
assert(
  toTelegramHtml("```ts\nconst x = 1\n```").includes("<pre>"),
  "fence",
);
assert(
  !toTelegramHtml("1 < 2 && 3 > 1").includes("< 2"),
  "raw angles escaped",
);

const withBtns = compileTelegram(`Готово

:::buttons
[Оплатить](https://pay.example/x)
[Отмена](callback:cancel)
:::
`);
assert(withBtns.html === "Готово", "buttons stripped from html");
assert(withBtns.buttons.length === 1, "one button row");
assert(withBtns.buttons[0]?.[0]?.url === "https://pay.example/x", "url button");
assert(withBtns.buttons[0]?.[1]?.callback_data === "cancel", "callback button");

const photo = compileTelegram("смотри\n![книга](https://img.example/a.jpg)");
assert(photo.photos[0]?.url === "https://img.example/a.jpg", "photo extracted");
assert(photo.photos[0]?.spoiler === false, "plain photo is not hidden");

const hidden = compileTelegram("!![обложка](https://img.example/s.jpg)");
assert(hidden.photos[0]?.url === "https://img.example/s.jpg", "spoiler photo url");
assert(hidden.photos[0]?.spoiler === true, "!![alt] is hidden media");
assert(
  compileTelegram("![!обложка](https://img.example/s.jpg)").photos[0]?.spoiler ===
    true,
  "![!alt] is hidden media",
);
assert(
  compileTelegram("![spoiler](https://img.example/s.jpg)").photos[0]?.spoiler ===
    true,
  "![spoiler] is hidden media",
);

const card = compileTelegram(`# Что такое форматирование сообщений?

> Telegram поддерживает разные виды оформления текста

- **Жирный**
- *Курсив*
- ++Подчёркнутый++
- ~~Зачёркнутый~~
- \`Моноширинный\`
- ||Спойлер||
`);
assert(card.html.includes("<b>Что такое форматирование сообщений?</b>"), "card heading");
assert(card.html.includes("<blockquote>Telegram поддерживает"), "card quote");
assert(card.html.includes("<b>Жирный</b>"), "card bold");
assert(card.html.includes("<i>Курсив</i>"), "card italic");
assert(card.html.includes("<u>Подчёркнутый</u>"), "card underline");
assert(card.html.includes("<s>Зачёркнутый</s>"), "card strike");
assert(card.html.includes("<code>Моноширинный</code>"), "card mono");
assert(card.html.includes("<tg-spoiler>Спойлер</tg-spoiler>"), "card spoiler");

const long = "п".repeat(5000);
const chunks = splitTelegramHtml(long, 4096);
assert(chunks.length >= 2, "split long");
assert(chunks.every((c) => c.length <= 4096), "chunks in limit");

const extracted = extractButtons(":::buttons\n[A](https://a.example)\n:::");
assert(extracted.buttons[0]?.[0]?.text === "A", "extract");

assert(
  toIMessageText(`Ссылка\n\n:::buttons\n[Открыть](https://example.com/a)\n:::`) ===
    "Ссылка\n\nОткрыть\nhttps://example.com/a",
  "imessage strips buttons to url lines",
);
assert(
  toIMessageText(":::buttons\n[Ок](callback:ok)\n:::") === "Ок",
  "imessage drops callback dest",
);
assert(
  toIMessageText(
    stripConnectUrls(
      "Открой\n\n:::buttons\n[Gmail](https://connect.composio.dev/link/lk_x)\n:::",
    ),
  ) === "Открой",
  "connect button strip",
);

assert(TELEGRAM_REACTIONS.love === "❤", "love emoji");
assert(isTelegramReaction("like"), "like allowed");
assert(!isTelegramReaction("heart"), "unknown reaction");

{
  resetTelegramSendGateForTests();
  const order: string[] = [];
  const first = enqueueTelegramChat(
    "1",
    async () => {
      order.push("a");
      return "a";
    },
    { gapMs: 20 },
  );
  const second = enqueueTelegramChat(
    "1",
    async () => {
      order.push("b");
      return "b";
    },
    { gapMs: 20 },
  );
  const other = enqueueTelegramChat(
    "2",
    async () => {
      order.push("c");
      return "c";
    },
    { gapMs: 20 },
  );
  const [a, c] = await Promise.all([first, other]);
  assert(a === "a" && c === "c", "first sends on two chats do not block each other");
  assert((await second) === "b", "same-chat second send still completes");
  assert(order.indexOf("a") < order.indexOf("b"), "same chat is serialized");
  const boom = enqueueTelegramChat(
    "3",
    async () => {
      throw new Error("nope");
    },
    { gapMs: 0 },
  );
  const afterFail = enqueueTelegramChat("3", async () => "ok", { gapMs: 0 });
  await boom.then(
    () => {
      throw new Error("failed send should reject");
    },
    () => undefined,
  );
  assert((await afterFail) === "ok", "failed send does not stall the chat gate");
  assert(TELEGRAM_SEND_GAP_MS >= 200, "iOS needs a gap between bot bubbles");
  resetTelegramSendGateForTests();
}

console.log("telegram-text-check ok");
