import {
  bubblesFor,
  firstCompleteLine,
  isIncompleteDraft,
  isLikelyCompleteBubble,
  isStatusBeat,
  isStreamFlushWorthy,
  isThinFragment,
  markTurnSpoke,
  nextBubble,
  turnLooking,
  turnSpoke,
  planPreToolFlush,
  planStreamFlush,
  planTurnDelivery,
  recordSent,
  visibleReply,
} from "../agent/lib/early-deliver.ts";
import { parkTurn } from "../agent/lib/channel-turn.ts";
import { TURN_FAILED_REPLY } from "../agent/lib/silent-turn.ts";
import { routingFromAuth, routingPhone } from "../agent/lib/turn-routing.ts";
import { channelFromAuth } from "../agent/lib/deliver-routed.ts";
import {
  imessageOwnsTurn,
  telegramOwnsTurn,
} from "../agent/lib/turn-delivery-events.ts";
import { isHeadingOnly, resetBubbleDedupe } from "../agent/lib/bubble-dedupe.ts";
import { deliverHuman } from "../agent/lib/deliver-human.ts";

import { assert, src } from "./lib/check.ts";

assert(visibleReply(null) === null, "null invisible");
assert(visibleReply("   ") === null, "whitespace invisible");
assert(visibleReply("[SILENT]") === null, "silent invisible");
assert(visibleReply("[SILENT] leftover") === null, "silent prefix invisible");
assert(visibleReply("  Ищу  ") === "Ищу", "trim visible");

assert(nextBubble([], "Ищу") === "Ищу", "first bubble");
assert(nextBubble(["Ищу"], "Ищу") === null, "exact dup skipped");
assert(nextBubble(["Ищу"], "Ищу\n\nНашёл три варианта") === "Нашёл три варианта", "accumulated remainder");
assert(nextBubble(["Ищу"], "Нашёл три варианта") === "Нашёл три варианта", "new independent bubble");
assert(nextBubble(["Ищу кроссовки"], "Ищу") === null, "shorter prefix of last skipped");

assert(firstCompleteLine("Ищу") === null, "partial first line stays");
assert(firstCompleteLine("\nИ") === null, "leading newline does not flush a crumb");
assert(firstCompleteLine("Ищу кроссовки\n") === "Ищу кроссовки", "newline completes the line");
assert(firstCompleteLine("[SILENT]\n") === null, "silent first line stays hidden");
assert(
  firstCompleteLine("Цена та же\n[SEEN] abc") === "Цена та же",
  "seen does not block a complete first line",
);

const streamFirst = planStreamFlush({ soFar: "Ищу 🔎\n", alreadySent: [] });
assert(streamFirst.send === "Ищу 🔎", "appended flushes the first complete line");

const streamPartial = planStreamFlush({ soFar: "Ищ", alreadySent: [] });
assert(streamPartial.send === null, "appended does not send a token crumb");

const streamAfter = planStreamFlush({
  soFar: "Ищу 🔎\n\nНашёл три варианта",
  alreadySent: ["Ищу 🔎"],
});
assert(streamAfter.send === null, "unterminated later text does not flush");
const streamNext = planStreamFlush({
  soFar: "Ищу 🔎\n\nНашёл три варианта\n",
  alreadySent: ["Ищу 🔎"],
});
assert(streamNext.send === "Нашёл три варианта", "later complete line flushes the remainder");
assert(
  planStreamFlush({
    soFar: "Ищу\nНашёл\nИтог\n",
    alreadySent: ["Ищу", "Нашёл"],
  }).send === "Итог",
  "third complete line is only the remainder after two bubbles",
);
assert(
  nextBubble(["Ищу", "Нашёл"], "Ищу\nНашёл\nИтог") === "Итог",
  "single-newline join still yields the last line",
);
assert(
  nextBubble(["Ок."], "Ок. Сейчас гляну джоб") === "Сейчас гляну джоб",
  "sentence flush remainder does not resend the first bubble",
);
assert(
  nextBubble(["ок"], "окей, сделаю") === "окей, сделаю",
  "ок is not a prefix of окей",
);
assert(
  nextBubble(
    [
      "Записываю в Инвитро на чекап.",
      "Открываю браузер — подберу ближайшее время и филиал.",
      "Здесь упираюсь в лимит браузера: на этот месяц задачи исчерпаны (сайт Инвитро без браузера не открыть).",
    ],
    "Записываю в Инвитро на чекап. Открываю браузер — подберу ближайшее время и филиал.\nЗдесь упираюсь в лимит браузера: на этот месяц задачи исчерпаны (сайт Инвитро без браузера не открыть). Два варианта:",
  ) === null,
  "heading-only remainder is not a new bubble",
);
assert(
  nextBubble(
    [
      "Здесь упираюсь в лимит браузера: на этот месяц задачи исчерпаны (сайт Инвитро без браузера не открыть). Два варианта:",
    ],
    "Два варианта:",
  ) === null,
  "suffix of an already-sent bubble is not resent",
);

{
  const sent = new Map<string, { at: number; bubbles: string[] }>();
  const turn = "invitro";
  const soFar = [
    "Записываю в Инвитро на чекап.",
    "Записываю в Инвитро на чекап. Открываю браузер — подберу ближайшее время и филиал.",
    "Записываю в Инвитро на чекап. Открываю браузер — подберу ближайшее время и филиал.\nЗдесь упираюсь в лимит браузера: на этот месяц задачи исчерпаны (сайт Инвитро без браузера не открыть). Два варианта:",
    "Записываю в Инвитро на чекап. Открываю браузер — подберу ближайшее время и филиал.\nЗдесь упираюсь в лимит браузера: на этот месяц задачи исчерпаны (сайт Инвитро без браузера не открыть). Два варианта:\n1. Подключаешь оплату лимита — сразу ищу филиал и время, записываю сам.",
    "Записываю в Инвитро на чекап. Открываю браузер — подберу ближайшее время и филиал.\nЗдесь упираюсь в лимит браузера: на этот месяц задачи исчерпаны (сайт Инвитро без браузера не открыть). Два варианта:\n1. Подключаешь оплату лимита — сразу ищу филиал и время, записываю сам.\n2. Или я скину ссылку на страницу записи Инвитро, и ты за пару кликов выберешь филиал и время сам — я только напомню и прослежу, чтобы не забыл.\nЧто выбираешь?",
  ];
  const flushed: string[] = [];
  for (const chunk of soFar) {
    const planned = planStreamFlush({
      soFar: chunk,
      alreadySent: bubblesFor(sent, turn),
    });
    if (planned.send) {
      recordSent(sent, turn, planned.send, Date.now());
      flushed.push(planned.send);
    }
  }
  const final = planTurnDelivery({
    finishReason: "stop",
    message: soFar[soFar.length - 1],
    origin: "human",
    alreadySent: bubblesFor(sent, turn),
  });
  assert(
    flushed[0] === "Записываю в Инвитро на чекап.",
    "first status line still leaves early",
  );
  assert(
    !flushed.some((b) => b.includes("Записываю") && b.includes("Два варианта")),
    "stream must not resend the already-flushed status lines",
  );
  assert(final.send === null, "completed must not replay the whole reply");
}

assert(isLikelyCompleteBubble("Ок!"), "exclaim is complete");
assert(isLikelyCompleteBubble("Ок."), "ок + period is complete");
assert(isLikelyCompleteBubble("Принял."), "long word + period is complete");
assert(isLikelyCompleteBubble("👍"), "emoji-only is complete");
assert(!isLikelyCompleteBubble("Ищ"), "crumb is not complete");
assert(!isLikelyCompleteBubble("Ищу ПВЗ на ул."), "abbreviation period is not complete");
assert(!isLikelyCompleteBubble("Ищу на Невском просп."), "просп. is not complete");
assert(!isLikelyCompleteBubble("бюджет 2 млрд."), "млрд. is not complete");
assert(!isLikelyCompleteBubble("Нашёл три варианта"), "unterminated sentence stays");
assert(!isLikelyCompleteBubble("Ищу 🔎"), "looking line with emoji is not a finished bubble");
assert(isLikelyCompleteBubble("Ок 👍"), "ack plus emoji is complete");
assert(!isLikelyCompleteBubble("Нашёл за 8490."), "price period is not a sentence");
assert(!isLikelyCompleteBubble("Ищу… кроссовки"), "ellipsis looking line is not peeled");
assert(!isLikelyCompleteBubble("Ищу..."), "ascii ellipsis looking line stays");
assert(
  planStreamFlush({ soFar: "Ищу... кроссовки", alreadySent: [] }).send === null,
  "ascii ellipsis does not peel Ищу.",
);
assert(!isLikelyCompleteBubble("Нашёл за 8490р."), "8490р. is still a price");
assert(
  nextBubble(["Готово!"], "Готово к отправке") === "Готово к отправке",
  "bare last word plus space is a new sentence, not a remainder",
);

assert(
  planStreamFlush({ soFar: "Ок!", alreadySent: [] }).send === "Ок!",
  "stream flushes a finished short reply without waiting for newline",
);
assert(
  planStreamFlush({ soFar: "Ищу ПВЗ на ул.", alreadySent: [] }).send === null,
  "stream does not flush an abbreviation",
);
assert(
  planStreamFlush({ soFar: "Ок.", alreadySent: [] }).send === "Ок.",
  "stream flushes ок with a period",
);
assert(
  planStreamFlush({ soFar: "Ок. Сейчас гляну джоб", alreadySent: [] }).send === "Ок.",
  "batched first sentence peels off the open line",
);

assert(isThinFragment("«"), "lone quote is a crumb");
assert(isThinFragment("• 🚄"), "emoji-only bullet is a crumb");
assert(isThinFragment("• 🏨"), "hotel emoji bullet is a crumb");
assert(isThinFragment("• 📍"), "pin emoji bullet is a crumb");
assert(isThinFragment("ru — от 21 000 до 50 000 ₽"), "torn TLD leftover is a crumb");
assert(!isThinFragment("👍"), "emoji ack is not a crumb");
assert(
  !isThinFragment("• 📅 10 и 11 октября 2026, начало в 20:00"),
  "full date bullet is not a crumb",
);
assert(isStatusBeat("Ищу 🔎"), "looking line is a status beat");
assert(isStatusBeat("Нашёл три варианта"), "short found line is a status beat");
assert(
  !isStatusBeat("• 📅 10 и 11 октября 2026, начало в 20:00"),
  "date bullet is not a status beat",
);
assert(
  !isStreamFlushWorthy("• 🚄", "• 🚄\n"),
  "stream must not send an emoji-only bullet",
);
assert(
  planStreamFlush({ soFar: "• 🚄\n", alreadySent: [] }).send === null,
  "stream holds a hanging train emoji",
);
assert(
  planStreamFlush({ soFar: "«\n", alreadySent: [] }).send === null,
  "stream holds a lone opening quote",
);
assert(
  planStreamFlush({
    soFar: "• 📅 10 и 11 октября 2026, начало в 20:00\n",
    alreadySent: [],
  }).send === null,
  "stream holds a single fact bullet for the rest of the list",
);

{
  const intro =
    "Вот главное про Канье в РФ (подтверждено, официально): Kanye West / Ye — «Ye Live Concert Tour 2026», Питер, «Газпром Арена»";
  const facts = [
    "• 📅 10 и 11 октября 2026, начало в 20:00",
    "• 📍",
    "«Газпром Арена», Крестовский остров, СПб (не Москва — слухи про Москву не подтвердились)",
    "• 🎫",
    "Билеты только на yerussia2026.ru — от 21 000 до 50 000 ₽",
    "• 🚄",
    "Добраться из Москвы: «Сапсан» от ~4600–8000 ₽ (на 11 октября мест больше и дешевле), обычный поезд от 2200 ₽ (9–10 часов в пути)",
    "• 🏨",
    "Жильё рядом (Петроградский): апартаменты от 2000–3000 ₽, отели 3★ от 5000 ₽ за ночь",
    "• ⚠️ Билеты, купленные до 23 августа, невозвратные (кроме отмены/переноса концерта)",
  ];
  const sent = new Map<string, { at: number; bubbles: string[] }>();
  const turn = "kanye";
  const flushed: string[] = [];
  let soFar = "";
  const push = (line: string, closed = true) => {
    soFar = soFar ? `${soFar}\n${line}` : line;
    const planned = planStreamFlush({
      soFar: closed ? `${soFar}\n` : soFar,
      alreadySent: bubblesFor(sent, turn),
    });
    if (planned.send) {
      recordSent(sent, turn, planned.send, Date.now());
      flushed.push(planned.send);
    }
  };
  push(intro);
  for (const line of facts) push(line);
  assert(flushed[0] === intro, "concert intro still leaves as the first bubble");
  assert(
    !flushed.some((b) => b === "• 🚄" || b === "• 🏨" || b === "• 📍" || b === "«"),
    "concert stream must not spam emoji crumbs",
  );
  assert(
    flushed.length <= 2,
    `concert facts stay grouped while streaming, got ${flushed.length} bubbles`,
  );
  const final = planTurnDelivery({
    finishReason: "stop",
    message: `${soFar}\n`,
    origin: "human",
    alreadySent: bubblesFor(sent, turn),
  });
  assert(final.send !== null, "concert remainder leaves once at the end");
  const all = [...flushed, final.send ?? ""];
  assert(
    all.some((b) => b.includes("Сапсан")) &&
      all.some((b) => b.includes("Жильё рядом")) &&
      all.some((b) => b.includes("невозвратные")),
    "travel, stay, and ticket warning still arrive",
  );
  assert(
    all.length <= 3,
    "concert reply is a few bubbles, not a line-by-line dump",
  );
  assert(
    all.some((b) => b.includes("10 и 11 октября") && b.includes("Сапсан")),
    "dates and travel stay in one facts bubble",
  );
}

{
  const item1 =
    "1. От: Ageree\nТема: PR run failed: verify — Wave 14\nДата: 26 августа 2026\nПредварительный текст: Верификация рабочего процесса завершилась неудачно и это достаточно длинная строка.";
  const soFar = `${item1}\n2. От: Ageree ещё одно длинное письмо`;
  const planned = planStreamFlush({ soFar, alreadySent: [] });
  assert(
    planned.send === item1,
    "long numbered Gmail item still leaves when the next item starts",
  );
}

assert(
  planStreamFlush({
    soFar:
      "• 📅 10 и 11 октября 2026, начало в 20:00\n• 🎤 Формат: купол\n\nДобраться из Москвы поездом",
    alreadySent: [],
  }).send ===
    "• 📅 10 и 11 октября 2026, начало в 20:00\n• 🎤 Формат: купол",
  "blank line closes a short bullet section",
);
assert(
  nextBubble(["Привет!"], "Привет. Как дела?") === "Как дела?",
  "punct rewrite still yields the remainder",
);
assert(
  nextBubble(["ok"], "ok, сделаю") === "сделаю",
  "comma after a flushed ack is stripped",
);
assert(
  nextBubble(
    [
      "Хм, у меня пока нет зарегистрированного компьютера — статус пустой, будить нечего.",
      "Похоже, компьютер ещё не привязан.",
    ],
    "Хм, у меня пока нет зарегистрированного компьютера — статус пустой, будить нечего. Похоже, компьютер ещё не привязан. Если не будится — напиши, разберёмся.",
  ) === "Если не будится — напиши, разберёмся.",
  "completed full reply peels already-flushed telegram bubbles",
);
assert(
  nextBubble(
    ["Привет!", "Как дела?"],
    "Привет. Как дела? Что нового?",
  ) === "Что нового?",
  "punct rewrite still peels each already-sent bubble in order",
);
{
  const pathA = [
    "Хм, у меня пока нет зарегистрированного компьютера — статус пустой, будить нечего.",
    "Похоже, компьютер ещё не привязан.",
  ];
  const full =
    "Хм, у меня пока нет зарегистрированного компьютера — статус пустой, будить нечего. Похоже, компьютер ещё не привязан.";
  assert(nextBubble(pathA, full) === null, "second path must not resend the joined reply");
  assert(nextBubble([], full) === full, "empty alreadySent still sends once — hook-only prevents a second empty map");
}

const streamThenFinal = planTurnDelivery({
  finishReason: "tool-calls",
  message: "Ищу 🔎\n\nНашёл три варианта",
  origin: "human",
  alreadySent: ["Ищу 🔎"],
});
assert(
  streamThenFinal.send === "Нашёл три варианта",
  "completed still sends the remainder after a streamed first line",
);
assert(
  nextBubble(["Ищу 🔎"], "Ищу 🔎  \n\nНашёл три варианта") === "Нашёл три варианта",
  "trailing spaces on the flushed line still yield the remainder",
);

const preTool = planPreToolFlush({ soFar: "Ищу кроссовки", alreadySent: [] });
assert(preTool.send === "Ищу кроссовки", "tool start flushes a line that never got a newline");
const preToolAfter = planPreToolFlush({
  soFar: "Ищу кроссовки",
  alreadySent: ["Ищу кроссовки"],
});
assert(preToolAfter.send === null, "tool start does not resend the streamed line");

const screenshotDraft =
  "Скриншот снял, но в чат картинку вложить не получается — файл лежит у тебя на компе, открой его там: png (полный размер) (";
const screenshotRestate =
  "Скриншот снял, но в чат картинку вложить не получается — файл лежит у тебя на компе, открой его там: /home/user/dt5.jpg (компактная версия, ~28 КБ)";
assert(isIncompleteDraft(screenshotDraft), "open paren draft is incomplete");
assert(isIncompleteDraft("/home/user/dt5."), "truncated computer path is incomplete");
assert(!isIncompleteDraft("Ищу кроссовки"), "plain looking line is flushable");
assert(
  planPreToolFlush({ soFar: screenshotDraft, alreadySent: [] }).send === null,
  "pre-tool does not flush a cut-off screenshot draft",
);
assert(
  planTurnDelivery({
    finishReason: "tool-calls",
    message: screenshotDraft,
    origin: "human",
    alreadySent: [],
  }).send === null,
  "tool-calls does not flush a cut-off screenshot draft",
);
assert(
  planTurnDelivery({
    finishReason: "tool-calls",
    message: screenshotRestate,
    origin: "human",
    alreadySent: [],
  }).send === screenshotRestate,
  "complete restatement still leaves once",
);
assert(
  nextBubble([screenshotDraft], screenshotRestate) !== screenshotRestate,
  "restated screenshot paragraph is not resent in full",
);
assert(
  nextBubble([screenshotRestate], screenshotRestate) === null,
  "exact screenshot restatement is skipped",
);
assert(
  planTurnDelivery({
    finishReason: "tool-calls",
    message: screenshotRestate,
    origin: "human",
    alreadySent: [screenshotRestate],
  }).send === null,
  "second tool-round does not spam the same screenshot paragraph",
);

assert(isHeadingOnly("Тяжёлая артиллерия:"), "short colon title is a heading");
assert(isHeadingOnly("**Тяжёлая артиллерия:**"), "md heading is a heading");
assert(
  !isHeadingOnly(
    "Что реально могу делать на твоём компе (уже проверил, что стоит Chrome, Python, Node, Git, ffmpeg):",
  ),
  "long colon line is not a heading",
);
assert(
  planPreToolFlush({ soFar: "Тяжёлая артиллерия:", alreadySent: [] }).send ===
    null,
  "pre-tool does not flush a heading",
);
assert(
  planTurnDelivery({
    finishReason: "tool-calls",
    message: "Тяжёлая артиллерия:",
    origin: "human",
    alreadySent: [],
  }).send === null,
  "tool-calls does not flush a heading",
);
assert(nextBubble([], "Тяжёлая артиллерия:") === null, "heading-only is never a bubble");
{
  resetBubbleDedupe();
  const texts: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    await deliverHuman({
      tenant: { inkboxHandle: "bro-test" },
      conversationId: "conv-heading",
      text: "Тяжёлая артиллерия:",
      channel: "imessage",
      deps: {
        sendIMessage: async (opts) => {
          texts.push(opts.text);
          return { service: "imessage" } as never;
        },
      },
    });
  }
  const leftoverCount = texts.length;
  assert(leftoverCount === 0, "six heading leftovers do not leave the chat");
  await deliverHuman({
    tenant: { inkboxHandle: "bro-test" },
    conversationId: "conv-heading",
    text: "Что реально могу делать на твоём компе. Уже есть Chrome, Python, Node.",
    channel: "imessage",
    deps: {
      sendIMessage: async (opts) => {
        texts.push(opts.text);
        return { service: "imessage" } as never;
      },
    },
  });
  await deliverHuman({
    tenant: { inkboxHandle: "bro-test" },
    conversationId: "conv-heading",
    text: "Что реально могу делать на твоём компе. Уже есть Chrome, Python, Node.",
    channel: "imessage",
    deps: {
      sendIMessage: async (opts) => {
        texts.push(opts.text);
        return { service: "imessage" } as never;
      },
    },
  });
  assert(texts.length === 1, "exact restatement is sent once");
}

const shotCut =
  "Скриншот снял, но в чат картинку вложить не получается — файл лежит у тебя на компе: /home/user/screens/shot.png (полный размер) (";
const shotJpg =
  "Скриншот снял, но в чат картинку вложить не получается — файл лежит у тебя на компе: /home/user/dt5.jpg";
assert(
  !isLikelyCompleteBubble(
    "Скриншот снял, но в чат картинку вложить не получается — файл лежит у тебя на компе: /home/user/screens/shot.",
  ),
  "filename period is not a finished sentence",
);
assert(
  planStreamFlush({ soFar: shotCut, alreadySent: [] }).send === null,
  "do not cut .png into a streamed bubble",
);
assert(
  planPreToolFlush({ soFar: shotCut, alreadySent: [] }).send === null,
  "do not flush png (",
);
{
  const peeled = nextBubble([shotCut], shotJpg);
  assert(
    peeled === null || !peeled.includes("Скриншот снял"),
    "restatement is not a new full bubble",
  );
}
assert(
  nextBubble([shotCut, shotJpg], "/home/user/dt5.") === null,
  "path fragment not resent",
);
assert(
  planTurnDelivery({
    finishReason: "stop",
    message: shotJpg,
    origin: "human",
    alreadySent: [
      "Снимаю экран.",
      "Скриншот снял, но в чат картинку вложить не получается.",
      "файл лежит у тебя на компе: /home/user/dt5.jpg",
    ],
  }).send === null,
  "completed must not replay after pre-tool remainder",
);
assert(
  nextBubble(
    [shotJpg],
    "Скриншот снял, но вложить картинку в чат не получается — файл лежит у тебя на компе: /home/user/dt5.jpg",
  ) === null,
  "word-swap restatement is not a new bubble",
);

const mid = planTurnDelivery({
  finishReason: "tool-calls",
  message: "Ищу 🔎",
  origin: "human",
  alreadySent: [],
});
assert(mid.send === "Ищу 🔎", "tool-calls text is delivered immediately");
assert(mid.fallback === null, "tool-calls never fallback");

const silentMid = planTurnDelivery({
  finishReason: "tool-calls",
  message: "[SILENT]",
  origin: "human",
  alreadySent: [],
});
assert(silentMid.send === null, "silent tool-calls stay quiet");

const seenMid = planTurnDelivery({
  finishReason: "tool-calls",
  message: "Цена та же\n[SEEN] abc",
  origin: "wakeup",
  alreadySent: [],
});
assert(seenMid.send === "Цена та же", "seen stripped on mid-turn");
assert(seenMid.seen === "abc", "seen captured on mid-turn");

const finalDup = planTurnDelivery({
  finishReason: "stop",
  message: "Ищу 🔎",
  origin: "human",
  alreadySent: ["Ищу 🔎"],
});
assert(finalDup.send === null, "final does not resend the mid-turn bubble");
assert(finalDup.fallback === null, "already spoke — no fallback");

const emptyAfterSpeak = planTurnDelivery({
  finishReason: "stop",
  message: null,
  origin: "human",
  alreadySent: ["Ищу"],
});
assert(emptyAfterSpeak.send === null, "empty final after speak");
assert(emptyAfterSpeak.fallback === null, "do not claim failure after a real bubble");

const emptyHuman = planTurnDelivery({
  finishReason: "stop",
  message: null,
  origin: "human",
  alreadySent: [],
});
assert(emptyHuman.fallback === TURN_FAILED_REPLY, "empty human turn still fallbacks");

const silentFinal = planTurnDelivery({
  finishReason: "stop",
  message: "[SILENT]",
  origin: "human",
  alreadySent: [],
});
assert(silentFinal.send === null, "final [SILENT] stays hidden");
assert(silentFinal.fallback === null, "[SILENT] is not a failure — tapback / ок");

const silentSeen = planTurnDelivery({
  finishReason: "stop",
  message: "[SILENT]\n[SEEN] price=1",
  origin: "human",
  alreadySent: [],
});
assert(silentSeen.send === null, "silent+seen stays hidden");
assert(silentSeen.fallback === null, "silent+seen is not a failure");
assert(silentSeen.seen === "price=1", "seen still captured on silent");

const emptyWakeup = planTurnDelivery({
  finishReason: "stop",
  message: "",
  origin: "wakeup",
  alreadySent: [],
});
assert(emptyWakeup.fallback === null, "wakeup may end empty");

markTurnSpoke("turn-a", 1_000);
assert(turnSpoke("turn-a", 1_500), "this turn spoke");
assert(!turnSpoke("turn-b", 1_500), "other turn has not spoken");
assert(!turnSpoke("turn-a", 1_000 + 11 * 60_000), "turn spoke ttl expires");

const sent = new Map<string, { at: number; bubbles: string[]; soFar?: string }>();
recordSent(sent, "t1", "Ищу", 1_000);
assert(bubblesFor(sent, "t1").join("|") === "Ищу", "record first");
assert(turnSpoke("t1", 1_000), "recordSent marks this turn as spoken");
assert(turnLooking("t1", 1_000), "ищу bubble marks the turn as looking");
recordSent(sent, "t-ack", "Ок!", 1_000);
assert(!turnLooking("t-ack", 1_000), "ок bubble is not a looking line");
recordSent(sent, "t1", "Нашёл", 2_000);
assert(bubblesFor(sent, "t1").join("|") === "Ищу|Нашёл", "record second");
assert(bubblesFor(sent, "t2").length === 0, "other turn empty");
recordSent(sent, "t1", "старое", 1_000 + 11 * 60_000);
assert(bubblesFor(sent, "t1").join("|") === "старое", "ttl expires the old row");

const channel = src("agent/channels/imessage.ts");
const delivery = src("agent/lib/turn-delivery-events.ts");
const telegramChannel = src("agent/channels/telegram.ts");
assert(channel.includes("imessageDeliveryEvents"), "imessage uses shared delivery events");
assert(
  !telegramChannel.includes("telegramDeliveryEvents"),
  "telegram channel does not register delivery events — hook is the only path",
);
const hook = src("agent/hooks/telegram-deliver.ts");
assert(hook.includes("telegramDeliveryEvents"), "hook is the telegram delivery path");
assert(hook.includes("defineHook"), "telegram hook observes every channel session");
assert(
  !/events:\s*telegramDeliveryEvents/.test(telegramChannel),
  "new telegram sessions must not also fire channel delivery events",
);
assert(delivery.includes("initiator"), "delivery reads initiator auth when current is empty");
assert(delivery.includes("canTarget"), "telegram can deliver without continuation token");
assert(delivery.includes("planTurnDelivery"), "shared events use early-deliver planner");
assert(delivery.includes("planStreamFlush"), "shared events flush streamed complete lines");
assert(delivery.includes("planPreToolFlush"), "shared events flush when the model starts a tool");
assert(delivery.includes('"message.appended"'), "shared events listen for streamed text");
assert(delivery.includes('"actions.requested"'), "shared events listen for the pre-tool boundary");
assert(delivery.includes("void deliverTurnBubble"), "early bubbles do not block the Eve pump");
assert(
  !/if \(event\.finishReason === ["']tool-calls["']\) return;/.test(delivery),
  "shared events no longer drop tool-calls text",
);
assert(
  !shouldSkipAgentOnAck(channel),
  "acks still reach the agent — ok/спасибо can continue a waiting job",
);

function shouldSkipAgentOnAck(src: string): boolean {
  return src.includes("instantTapback");
}

let parked = 0;
parkTurn((work) => {
  parked += 1;
  void work;
}, Promise.resolve());
assert(parked === 1, "parkTurn uses waitUntil when present");
parkTurn(undefined, Promise.resolve());
assert(parked === 1, "missing waitUntil does not throw");

const telegramHuman = routingFromAuth({
  origin: "human",
  channel: "telegram",
  telegramChatId: "42",
});
assert(telegramHuman.canDeliver === true, "telegram attrs deliver without tenant");
assert(telegramHuman.channel === "telegram", "telegram channel from attrs");
assert(telegramHuman.telegramChatId === "42", "telegram chat id from attrs");

const imessageHuman = routingFromAuth({
  origin: "human",
  inkboxHandle: "+7999",
});
assert(imessageHuman.canDeliver === true, "human iMessage delivers without tenant");
assert(imessageHuman.channel === "imessage", "human iMessage stays on this conversation");

const wakeup = routingFromAuth({
  origin: "wakeup",
  conversationId: "c1",
  inkboxHandle: "+7999",
});
assert(wakeup.canDeliver === false, "wakeup still needs tenant lastChannel");
assert(wakeup.channel === undefined, "wakeup does not guess iMessage from handle");

const group = routingFromAuth({
  origin: "human",
  inkboxHandle: "+7999",
  ownerPhone: "+7000",
});
assert(routingPhone(group, undefined) === "+7000", "group seen uses ownerPhone");
assert(routingPhone(group, "+7111") === "+7111", "principal wins over owner");
assert(
  channelFromAuth({ origin: "human", channel: "telegram", telegramChatId: "1" }, "imessage") ===
    "telegram",
  "tool notify follows auth, not stale lastChannel",
);
assert(
  channelFromAuth({ origin: "wakeup" }, "telegram") === "telegram",
  "wakeup tool notify still uses lastChannel",
);

assert(telegramOwnsTurn({ origin: "human", channel: "telegram", telegramChatId: "1" }), "telegram stamp");
assert(!telegramOwnsTurn({ origin: "human" }), "human iMessage is not telegram-owned");
assert(!telegramOwnsTurn({ origin: "wakeup" }), "wakeup is not telegram-owned");
assert(imessageOwnsTurn({ origin: "human" }), "human iMessage stays on imessage events");
assert(imessageOwnsTurn({ origin: "wakeup" }), "wakeup stays on imessage events");
assert(
  !imessageOwnsTurn({ origin: "human", channel: "telegram", telegramChatId: "1" }),
  "imessage events skip telegram-stamped turns",
);

assert(delivery.includes("routingFromAuth"), "shared events use auth routing");
assert(delivery.includes("deliverTurnBubble"), "shared events share delivery helper");
const bubbleFn = delivery.slice(delivery.indexOf("export async function deliverTurnBubble"));
assert(
  bubbleFn.indexOf("deliverHuman") < bubbleFn.indexOf("persistSeen"),
  "lastSeen waits until after the bubble is sent",
);
const appended = delivery.slice(delivery.indexOf('"message.appended"'));
assert(
  appended.indexOf("recordSent") < appended.indexOf("void deliverTurnBubble"),
  "appended recordSent before deliver closes the overlap window",
);
const preToolEv = delivery.slice(
  delivery.indexOf('"actions.requested"'),
  delivery.indexOf('"message.completed"'),
);
assert(
  preToolEv.indexOf("recordSent") < preToolEv.indexOf("void deliverTurnBubble"),
  "pre-tool recordSent before deliver closes the overlap window",
);
assert(
  !preToolEv.includes("await deliverTurnBubble"),
  "pre-tool send is not awaited",
);
const completed = delivery.slice(delivery.indexOf('"message.completed"'));
assert(
  completed.indexOf("recordSent") < completed.indexOf("await deliverTurnBubble"),
  "recordSent before deliver closes the overlap window",
);
assert(
  !/if \(bubblesFor\(earlySent, event\.turnId\)\.length > 0\) return;/.test(
    delivery,
  ),
  "turn.failed still speaks after an early bubble",
);

console.log("early-deliver-check ok");
