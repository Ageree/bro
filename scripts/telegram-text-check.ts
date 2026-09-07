import { stripConnectUrls } from "../agent/lib/connect-link.ts";
import { toIMessageText } from "../agent/lib/imessage-text.ts";
import {
  compileTelegram,
  escapeHtml,
  extractButtons,
  splitTelegramHtml,
  toTelegramHtml,
} from "../agent/lib/telegram-text.ts";
import { isTelegramReaction, TELEGRAM_REACTIONS } from "../agent/lib/telegram.ts";

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
assert(photo.photos[0] === "https://img.example/a.jpg", "photo extracted");

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

console.log("telegram-text-check ok");
