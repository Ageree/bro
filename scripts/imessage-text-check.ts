import { stripConnectUrls } from "../agent/lib/connect-link.ts";
import {
  inboundIMessageText,
  toBold,
  toIMessageBubbles,
  toIMessageText,
} from "../agent/lib/imessage-text.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(toIMessageText("просто текст") === "просто текст", "plain");

assert(toBold("hello") !== "hello", "latin maps");
assert(toBold("От") === "От", "cyrillic stays (no mixed fake-bold)");
assert(toIMessageText("**hello**") === toBold("hello"), "md latin bold");
assert(
  toIMessageText("**От:** Ageree") === "▸ От: Ageree",
  "cyrillic label mark",
);

assert(
  toIMessageText("[Просмотреть сообщение](https://mail.google.com/x)") ===
    "Просмотреть сообщение\nhttps://mail.google.com/x",
  "markdown link",
);

assert(
  toIMessageText("**[Открыть](https://example.com/a)**") ===
    "Открыть\nhttps://example.com/a",
  "bold markdown link",
);

assert(
  toIMessageText("Пиши `browser_task` и **жди**") ===
    "Пиши browser_task и жди",
  "inline code and bold",
);

assert(
  toIMessageText("- один\n- два") === "• один\n• два",
  "ul",
);

assert(
  toIMessageText("# Заголовок\nтекст") === "Заголовок\nтекст",
  "heading",
);

assert(
  toIMessageText("<notifications@github.com>") === "notifications@github.com",
  "autolink email",
);

assert(
  toIMessageText("```\ncode\n```") === "code",
  "fence",
);

const gmail = `Вот несколько непрочитанных писем в Gmail:

1. **От:** Ageree
<notifications@github.com>
  **Тема:** [Ageree/cyber-company] PR run failed: verify - Wave 14
  **Дата:** 26 августа 2026, 20:42:07 UTC
  **Предварительный текст:** Верификация рабочего процесса завершилась неудачно.
  **[Просмотреть сообщение](https://mail.google.com/mail/u/0/#inbox/1a03fcf0f1a8bcff)**

2. **От:** Ageree
<notifications@github.com>
  **Тема:** другой PR
  **Дата:** 26 августа 2026, 21:00:00 UTC
  **Предварительный текст:** Ещё одно письмо достаточно длинное чтобы splittить.
  **[Просмотреть сообщение](https://mail.google.com/mail/u/0/#inbox/deadbeef)**`;

const gmailOut = toIMessageText(gmail);
assert(!gmailOut.includes("**"), "gmail no bold marks");
assert(!gmailOut.includes("]("), "gmail no md links");
assert(gmailOut.includes("▸ От: Ageree"), "gmail from");
assert(gmailOut.includes("▸ Тема:"), "gmail subject");
assert(
  gmailOut.includes("https://mail.google.com/mail/u/0/#inbox/1a03fcf0f1a8bcff"),
  "gmail url kept",
);
assert(gmailOut.includes("notifications@github.com"), "gmail email kept");

const bubbles = toIMessageBubbles(gmail);
assert(bubbles.length >= 3, `gmail split got ${bubbles.length}`);
assert(bubbles[0].startsWith("Вот несколько"), "intro bubble");
assert(bubbles[1].startsWith("1. "), "first item bubble");
assert(bubbles[2].startsWith("2. "), "second item bubble");

assert(
  toIMessageBubbles("1. да\n2. нет").length === 1,
  "short numbered stays one bubble",
);

assert(toIMessageBubbles("").length === 0, "empty");
assert(toIMessageBubbles("   **  **").length === 0, "only marks");

assert(
  inboundIMessageText({ content: "  фото  " }) === "фото",
  "inbound text",
);
assert(
  inboundIMessageText({
    content: null,
    media: [{ url: "https://media.example/p.jpg", content_type: "image/jpeg" }],
  }) === "https://media.example/p.jpg",
  "inbound media only",
);
assert(
  inboundIMessageText({
    content: "смотри",
    media: [{ url: "https://media.example/p.jpg" }],
  }) === "смотри\nhttps://media.example/p.jpg",
  "inbound caption+media",
);
assert(
  inboundIMessageText({ content: "  ", media: [], message_type: "carousel" }) ===
    "[carousel]",
  "empty carousel marker",
);
assert(inboundIMessageText({ content: null, media: null }) === "", "inbound empty");

assert(toIMessageText(gmailOut) === gmailOut, "idempotent");

assert(
  toIMessageText(
    stripConnectUrls(
      "Открой [Gmail](https://connect.composio.dev/link/lk_x) **сейчас**",
    ),
  ) === "Открой сейчас",
  "connect strip then markdown",
);

console.log("imessage-text-check ok");
