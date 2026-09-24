import type { ModelMessage, ToolResultPart } from "ai";
import { describe, expect, it } from "vitest";
import {
  repeatsDelivered,
  rewriteSendNotice,
  sendReachedPerson,
  sendRefusal,
  sentMessageOf,
  skippedSendNotice,
  turnMessageLimit,
  turnMustEnd,
  turnSends,
} from "@agent/lib/delivery/turn-sends";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

const callRestaurant = "Пришли название ресторана — я позвоню.";

describe("sendRefusal", () => {
  it("lets the first message of a turn through", () => {
    expect(refusal([userMessage("найди")], callRestaurant)).toBeUndefined();
  });

  it.each([
    ["the same text", callRestaurant],
    ["other case and spacing", "  пришли   НАЗВАНИЕ ресторана — я позвоню "],
    ["other punctuation", "Пришли название ресторана, я позвоню!"],
    ["a near copy", "Пришли название ресторана — и я позвоню."],
  ])("drops %s as a repeat", (_case, text) => {
    expect(
      refusal([userMessage("найди"), ...sendMessage("a", callRestaurant)], text)
    ).toEqual({ skipped: "duplicate" });
  });

  it.each([
    [
      "the return flight after the outbound one",
      "Рейс SU 1234 Москва—Сочи 12 октября, вылет в 08:40 из Шереметьево, место у окна.",
      "Рейс SU 1235 Сочи—Москва 19 октября, вылет в 18:05 из Сочи, место у окна.",
    ],
    [
      "the second option after the first",
      "Вариант 1: Отель «Морской», 4 звезды, 7 400 ₽ за ночь, завтрак включён.",
      "Вариант 2: Отель «Горный», 4 звезды, 6 900 ₽ за ночь, завтрак включён.",
    ],
    [
      "a reminder that differs in name and time",
      "Готово, напомню тебе позвонить Ане завтра в 10:00.",
      "Готово, напомню тебе позвонить Пете завтра в 11:00.",
    ],
    [
      "a result that differs only in a lowercase code",
      "Готово, заказ оформлен, номер заказа order_ab, трек придёт письмом.",
      "Готово, заказ оформлен, номер заказа order_cd, трек придёт письмом.",
    ],
    [
      "the same news about a different person opening the sentence",
      "Анна придёт завтра в 10:00, я предупредил охрану.",
      "Мария придёт завтра в 10:00, я предупредил охрану.",
    ],
    [
      "a payment link that differs only in punctuation",
      "Ссылка на оплату счёта: https://pay.example/inv-1-2",
      "Ссылка на оплату счёта: https://pay.example/inv_1.2",
    ],
    [
      "the next quiz question",
      "Вопрос 3: какая река самая длинная в Европе?",
      "Вопрос 4: какая река самая длинная в Азии?",
    ],
    [
      "a confirmation question after the result",
      "Нашёл столик в «Пушкине» на 20:00 на двоих.",
      "Бронировать столик в «Пушкине» на 20:00 на двоих?",
    ],
    [
      "a place the first message did not name",
      "Столик на 20:00 свободен.",
      "Ещё есть веранда в «Пушкине» на то же время 20:00.",
    ],
  ])("delivers %s right after it", (_case, first, second) => {
    expect(
      refusal([userMessage("найди"), ...sendMessage("a", first)], second)
    ).toBeUndefined();
  });

  it("delivers the same caption with different photos", () => {
    const history = [
      userMessage("покажи"),
      ...sendInput("a", photo("https://media.example/1.jpg")),
    ];

    expect(
      sendRefusal(photo("https://media.example/2.jpg"), turnSends(history))
    ).toBeUndefined();
    expect(
      sendRefusal(photo("https://media.example/1.jpg"), turnSends(history))
    ).toEqual({ skipped: "duplicate" });
  });

  it("drops a repeated native link", () => {
    const link = { kind: "link" as const, url: "https://brobro.tech/x" };

    expect(repeatsDelivered(link, [sentMessageOf(link)])).toBe(true);
  });

  it("stops every send once the turn used up its limit", () => {
    const sends = Array.from({ length: turnMessageLimit }, (_, index) =>
      sendMessage(`call-${String(index)}`, `Вопрос номер ${String(index)}?`)
    );
    const full = [userMessage("викторину"), ...sends.flat()];

    expect(refusal(full, "Вопрос номер 9?")).toEqual({ skipped: "limit" });
    expect(
      refusal([userMessage("викторину"), ...sends.slice(1).flat()], "Вопрос 9?")
    ).toBeUndefined();
  });
});

/**
 * Turns from the production benchmark of 24.09.2026: after the first
 * message went out, the model kept rephrasing it, step after step. Each
 * later text is what it sent next.
 */
describe("sendRefusal on rephrased replies from the benchmark", () => {
  it.each([
    [
      "«на вы» said six times (d15)",
      [toolStep("form_of_address", { formal: true })],
      "перешёл на «вы», так и буду обращаться.\n\nпо барбершопу напомню: запись пока не ушла, жду, пока вы подтвердите карточку. после этого сразу найду салон с артуром на профсоюзной и пришлю название, адрес, время и цену.",
      [
        "готово, теперь на «вы».\n\nнапоминаю: запись в барбершоп ещё не ушла — жду вашего подтверждения карточки. как подтвердите, найду салон с артуром на профсоюзной и пришлю название, адрес, время и цену.",
        "записал: теперь только «вы».\n\nи напомню про барбершоп — запись пока не ушла, жду вашего подтверждения карточки. как подтвердите, найду салон с артуром на профсоюзной и сразу пришлю название, адрес, время и цену.",
        "записал, дальше только на «вы».\n\nпо барбершопу: запись ещё не ушла, жду, пока вы подтвердите карточку. после этого найду салон с артуром на профсоюзной и пришлю название, адрес, время и цену.",
        "перешёл на «вы», так и останется.\n\nи напоминание: запись в барбершоп пока не ушла — жду, пока вы подтвердите карточку. как подтвердите, сразу найду салон с артуром на профсоюзной и пришлю название, адрес, время и цену.",
      ],
    ],
    [
      "no address, said again and again (d15)",
      [toolStep("list_orders", { orders: [] })],
      "адреса нет, и название не скажу — записи-то не было. карточку на барбершоп ты не подтвердил, так что в салон никто не звонил и не писал.\n\nв заказах тоже пусто по этой части — там висит только неоплаченный заказ №1234567 на 1580 ₽.\n\nскажи «запиши» — отправлю поручение заново, и как найдётся салон с артуром на профсоюзной, пришлю название, адрес и время.",
      [
        "готово, жду отмашку. скажи «запиши» — и как только найдётся барбершоп с артуром на профсоюзной, сразу скину название, адрес и время.",
        "название и адрес пока никакие — записи не было, карточку ты не подтвердил. в заказах по барбершопу тоже пусто.\n\nскажи «запиши» — отправлю поручение заново, и как только найдётся салон с артуром на профсоюзной, сразу пришлю название, адрес и время.",
        "названия и адреса пока нет — записи в барбершоп не было, карточку ты не подтвердил, так что салон я не искал и не бронировал. в заказах по этому делу тоже пусто.\n\nскажи «запиши» — отправлю поручение заново, найду барбершоп с артуром на профсоюзной и сразу пришлю название, адрес и время.",
      ],
    ],
    [
      "the same answer with an apology (d18)",
      [toolStep("gmail-search", { messages: [] })],
      "Посмотрел почту: письма с записью к стоматологу на эту пятницу нет — последнее такое от Euromed в апреле 2024. Скажите время и клинику, поставлю в календарь и вызову такси.\n\nЛёше написать «освобожусь не раньше восьми»? Скажите, куда — я вижу только телефон +79990000000, почты нет.",
      [
        "Прошу прощения, поправлюсь: письма с записью к стоматологу на эту пятницу в почте нет — последнее такое от Euromed датировано апрелем 2024. Назовите время и клинику, и я поставлю приём в календарь и вызову такси с запасом.\n\nЛёше написать «освобожусь не раньше восьми»? Вижу только телефон +79990000000, почты нет — скажите, куда отправлять.",
        "По почте поискал: письма с записью к стоматологу на эту пятницу нет, последнее такое от Euromed датировано апрелем 2024. Назовите время и клинику — поставлю приём в календарь и вызову такси с запасом.\n\nЛёше написать «освобожусь не раньше восьми»? Вижу только телефон +79990000000, почты нет — скажите, куда отправлять.",
        "Я поискал в почте: письма с записью к стоматологу на эту пятницу нет. Последнее такое — от Euromed, апрель 2024, и оно не про эту неделю. Назовите время и клинику, и я поставлю приём в календарь и вызову такси с запасом.\n\nЛёше написать «освобожусь не раньше восьми»? Я вижу только его телефон +79990000000, почты нет — скажите, куда отправлять.",
      ],
    ],
    [
      "«запуск ещё работает» in other words (d05)",
      [toolStep("browser_task", { outcome: "Result: …", status: "done" })],
      "Пока так: заказ ещё не размещён. Лавка не подошла, и запуск собрал корзину в Перекрёстке — вышло 1 085,95 ₽ за товары, доставка от 99 ₽. Слот к 20:00 пока не подтверждён, сайт просит выбрать адрес доставки.\n\nПродолжаю: подтверждаю адрес и проверяю слот к восьми. Как только соберётся точный состав и итог, пришлю отдельно — там же будет, что удалось заменить.",
      [
        "Коротко: запуск ещё работает — сайт сейчас проверяет слот к 20:00 и добирает корзину. Ориентир по деньгам: около 1 086 ₽ за товары плюс доставка от 99 ₽.\n\nТочный состав, итоговую сумму, время доставки и список замен пришлю отдельным сообщением, как только сайт ответит.",
        "Запуск всё ещё в работе: сайт проверяет слот к 20:00 и добирает корзину. Ориентир по деньгам — около 1 086 ₽ за товары плюс доставка от 99 ₽.\n\nТочный состав, итоговую сумму, время доставки и список замен пришлю отдельным сообщением, как только сайт ответит.",
      ],
    ],
    [
      "«пока смотрю» after the run was handed the code (d06)",
      [toolStep("browser_task", { runId: "run-2", status: "running" })],
      "код передал, жду, что покажет страница. отпишусь с результатом.",
      [
        "пока смотрю — как только кабинет отдаст данные, пришлю штрафы, налоги и срок загранника.",
        "как только страница отдаст данные — пришлю одним сообщением: штрафы, налоги и дату окончания загранника.",
      ],
    ],
    [
      "«ищу сам» after the answer (d02)",
      [toolStep("browser_task", { runId: "run-1", status: "running" })],
      "Понял: Москва — Сочи туда в пятницу 9 октября утром, обратно в понедельник 12-го вечером, с багажом, место у прохода, до 20 000 ₽ туда-обратно.\n\nИщу варианты сейчас — займёт минут пятнадцать, пришлю ссылки на лучшие.",
      [
        "Ищу сам, ничего дополнительно не нужно — как только увижу варианты, пришлю их тебе со ссылками.",
        "Поиск идёт в фоне: смотрю утренние вылеты 9 октября и вечерние обратные 12-го, с багажом и местом у прохода, до 20 000 ₽. Как будут варианты — сразу пришлю ссылки.",
      ],
    ],
  ])("drops each rephrasing of %s", (_case, work, first, next) => {
    const history = [
      userMessage("сообщение человека"),
      ...work.flat(),
      ...sendMessage("first", first),
    ];

    for (const text of next) {
      const refused = refusal(history, text);
      expect(
        refused && "skipped" in refused ? refused.skipped : refused
      ).toMatch(/^(?:duplicate|stale)$/u);
    }
  });

  it("still delivers a question the first message did not ask (d02)", () => {
    const history = [
      userMessage("найди билеты и зарегистрируй меня"),
      ...sendMessage(
        "first",
        "Ищу варианты сейчас — займёт минут пятнадцать, пришлю ссылки на лучшие. Сам зарегистрировать не могу, но заведу проверку."
      ),
    ];

    expect(
      refusal(
        history,
        "Уточни одну вещь: ставить проверку регистрации на утро среды или на сутки до вылета? Как скажешь — заведу сразу."
      )
    ).toBeUndefined();
    const asked = [
      ...history,
      ...sendMessage(
        "second",
        "Уточни одну вещь: ставить проверку регистрации на утро среды или на сутки до вылета?"
      ),
    ];
    expect(
      refusal(
        asked,
        "Остался один вопрос: проверку регистрации поставить на утро среды или за сутки до вылета?"
      )
    ).toEqual({ skipped: "stale" });
  });

  it("delivers what further work found, even in words alone", () => {
    const history = [
      userMessage("найди письмо от клиники"),
      ...sendMessage("ack", "Смотрю почту."),
      ...toolStep("gmail-search", { messages: [] }),
    ];

    expect(
      refusal(
        history,
        "Письма от клиники нет. Скажи, как она называется — поищу по названию."
      )
    ).toBeUndefined();
  });

  it("drops status after further work when it tells nothing new", () => {
    const history = [
      userMessage("что с заказом?"),
      ...sendMessage(
        "first",
        "Корзина в Перекрёстке собрана: 1 085,95 ₽, слот к 20:00 проверяю."
      ),
      ...toolStep("browser_task", { runId: "run-3", status: "running" }),
    ];

    expect(
      refusal(
        history,
        "Продолжаю в том же браузере: сейчас проверяю слот к 20:00 и добираю корзину. Как только сайт даст точный состав — напишу вам сразу."
      )
    ).toEqual({ skipped: "stale" });
  });
});

/**
 * A browser run's result, as its report turn opens (RU 24.09: the result
 * came twice in d05, d06, d08 and d18, and d08 corrected itself).
 */
describe("sendRefusal in a browser report's turn", () => {
  const report = userMessage(
    `${backgroundTurnMarker}\n\nBrowser run run-1 finished.\n\nResult: readings submitted.`
  );
  const told = [
    report,
    ...sendMessage(
      "result",
      "Передал показания в mos.ru: горячая вода 123,4, холодная 234,5. Приняли, следующий приём с 15-го."
    ),
  ];

  it.each([
    [
      "a correction of the same result (d08)",
      "Поправка: на фото был электросчётчик, а не вода — день 12345, ночь 6789. Передал их в Мосэнергосбыт.",
    ],
    [
      "the same result with a detail added",
      "Кстати, показания приняты в 14:05, квитанция придёт на почту до 1-го числа.",
    ],
    [
      "the same result restated",
      "Итог: показания воды 123,4 и 234,5 ушли в mos.ru, всё принято.",
    ],
  ])("drops %s", (_case, text) => {
    expect(refusal(told, text)).toEqual({ skipped: "reported" });
  });

  it.each([
    [
      "a request for a code",
      "Мосэнергосбыт прислал код на +7 999 000-00-00 — пришли его, введу сам.",
    ],
    ["a question", "Поставить напоминание передать показания в октябре?"],
    ["a new link", "Квитанция за сентябрь: https://example.ru/receipt/9"],
  ])("delivers %s after the result", (_case, text) => {
    expect(refusal(told, text)).toBeUndefined();
  });

  it("delivers a picture the result did not carry", () => {
    expect(
      sendRefusal(photo("https://media.example/receipt.jpg"), turnSends(told))
    ).toBeUndefined();
  });

  it("does not ask the same thing twice", () => {
    const asked = [
      ...told,
      ...sendMessage("ask", "Пришли код из СМС — введу сам."),
    ];

    expect(refusal(asked, "Жду код из СМС: пришли его сюда.")).toEqual({
      skipped: "reported",
    });
  });

  it("drops a message after a quiet continue: the run reports on its own", () => {
    const continued = [
      ...told,
      ...toolStep("browser_task", { runId: "run-2", status: "running" }),
    ];

    expect(
      refusal(continued, "Передаю ещё и электричество: день 12345, ночь 6789.")
    ).toEqual({ skipped: "reported" });
  });

  it("delivers what other work of the turn did since", () => {
    const reminded = [
      ...told,
      ...toolStep("schedules-create", { id: "job-1", status: "active" }),
    ];

    expect(
      refusal(reminded, "Поставил напоминание на 15 октября, 10:00.")
    ).toBeUndefined();
  });

  it.each([
    ["a heading", "Вот что нашёл:"],
    ["a question on its own", "Какой вариант берём?"],
    ["a status", "Секунду, смотрю, что нашёл браузер."],
  ])(
    "delivers the result after %s sent before it (review #0)",
    (_case, first) => {
      const opened = [report, ...sendMessage("first", first)];

      expect(
        refusal(opened, "Сапсан 18:40 за 5 200 ₽ и Ласточка 19:10 за 3 100 ₽.")
      ).toBeUndefined();
    }
  );

  it("returns a first message that only announces the result", () => {
    expect(refusal([report], "Секунду, смотрю, что нашёл браузер.")).toEqual({
      rewrite: "report",
    });
    // An announcement carrying the result is the result.
    expect(
      refusal([report], "Нашёл: Сапсан 18:40 за 5 200 ₽, пришлю ссылку.")
    ).toBeUndefined();
  });

  it.each([
    [
      "ran out of credits",
      { type: "json" as const, value: { status: "unavailable" } },
    ],
    [
      "was refused",
      { type: "json" as const, value: { status: "needs_approval" } },
    ],
    ["failed", { type: "error-text" as const, value: "Browser Use 500" }],
  ])(
    "delivers the news that the errand's continue %s (review #2)",
    (_case, output) => {
      const failed = [
        ...told,
        {
          content: [
            {
              input: { action: "continue" },
              toolCallId: "continue-1",
              toolName: "browser_task",
              type: "tool-call" as const,
            },
          ],
          role: "assistant" as const,
        },
        {
          content: [
            {
              output,
              toolCallId: "continue-1",
              toolName: "browser_task",
              type: "tool-result" as const,
            },
          ],
          role: "tool" as const,
        },
      ];

      expect(
        refusal(failed, "Сервис браузера сейчас недоступен, бронь не сделана.")
      ).toBeUndefined();
    }
  );

  it("delivers another errand's outcome that status handed over (review #9)", () => {
    const other = [
      ...told,
      ...toolStep("browser_task", {
        outcome: "Result: tickets ordered, order 123, 1 085 ₽.",
        runId: "run-2",
        status: "done",
      }),
    ];
    const own = [
      ...told,
      ...toolStep("browser_task", {
        outcome: "Result: readings submitted.",
        runId: "run-1",
        status: "done",
      }),
    ];

    expect(
      refusal(other, "Билеты оформлены, заказ №123, 1 085 ₽.")
    ).toBeUndefined();
    expect(refusal(own, "Показания 123,4 и 234,5 приняты в mos.ru.")).toEqual({
      skipped: "reported",
    });
  });

  it("leaves a person's turn free to say more", () => {
    const history = [
      userMessage("передай показания"),
      ...sendMessage(
        "result",
        "Передал показания в mos.ru: горячая вода 123,4, холодная 234,5."
      ),
    ];

    expect(
      refusal(history, "Поправка: электросчётчик — день 12345, ночь 6789.")
    ).toBeUndefined();
  });
});

describe("sendRefusal on a status before any work", () => {
  it.each([
    ["«смотрю почту»", "найди письмо от клиники", "Смотрю почту, секунду."],
    [
      "a promise of the answer later",
      "что у меня завтра в календаре?",
      "Сейчас посмотрю календарь и напишу, что там завтра.",
    ],
    [
      "the request echoed with a promise",
      "найди билеты в Сочи на 9 октября",
      "Ищу билеты в Сочи на 9 октября — как найду, пришлю варианты.",
    ],
  ])("returns %s for a rewrite", (_case, request, text) => {
    expect(refusal([userMessage(request)], text)).toEqual({
      rewrite: "status",
    });
  });

  it("lets it through once the turn has started the work", () => {
    const started = [
      userMessage("найди билеты в Сочи на 9 октября"),
      ...toolStep("browser_task", { runId: "run-1", status: "running" }),
    ];

    expect(
      refusal(
        started,
        "Ищу билеты в Сочи на 9 октября — как найду, пришлю варианты."
      )
    ).toBeUndefined();
  });

  it.each([
    [
      "a question",
      "Сейчас посмотрю — тебе на какое время удобнее, утро или вечер?",
    ],
    ["a request", "Пришли код из СМС — введу и напишу, что там."],
    [
      "a fact the person did not name",
      "Кафе работает до 22:00, если что-то поменяется — напишу.",
    ],
    [
      "a longer answer about what Bro does",
      "Ищу билеты и отели, бронирую столики, записываю к врачу, напоминаю о делах и разбираю почту.",
    ],
  ])("delivers an answer with %s", (_case, text) => {
    expect(refusal([userMessage("что умеешь?")], text)).toBeUndefined();
  });

  it("lets «пришлю, как найду» through about an errand already at work (review #10)", () => {
    const history = [
      userMessage("найди билеты в Сочи на 9 октября"),
      ...toolStep("browser_task", { runId: "run-1", status: "running" }),
      ...sendMessage("started", "Ищу билеты в Сочи, пришлю варианты."),
      userMessage("ок, жду"),
    ];

    expect(refusal(history, "Хорошо, пришлю, как найду.")).toBeUndefined();
    // Once the run has reported, a new errand is not at work any more.
    const reported = [
      ...history,
      userMessage(`${backgroundTurnMarker}\n\nBrowser run run-1 finished.`),
      ...sendMessage("result", "Нашёл: Сапсан 18:40 за 5 200 ₽."),
      userMessage("найди отель там же"),
    ];
    expect(refusal(reported, "Ищу отель, пришлю варианты.")).toEqual({
      rewrite: "status",
    });
  });

  it("never tells the model to start an errand a second time (review #10)", () => {
    const notice = rewriteSendNotice("status");

    expect(notice).not.toMatch(/start it/u);
    expect(notice).toContain("Never start the same errand twice");
  });

  it("checks no status in a turn Bro opened", () => {
    expect(
      refusal(
        [
          userMessage(
            `${backgroundTurnMarker}\n\nA scheduled run has completed.`
          ),
        ],
        "Смотрю почту, секунду."
      )
    ).toBeUndefined();
  });

  it("lets a status through once the model kept it twice", () => {
    const rewritten = [
      userMessage("найди письмо от клиники"),
      ...sendMessage(
        "a",
        "Смотрю почту.",
        textOutput(rewriteSendNotice("status"))
      ),
      ...sendMessage(
        "b",
        "Смотрю почту.",
        textOutput(rewriteSendNotice("status"))
      ),
    ];

    expect(refusal(rewritten, "Смотрю почту.")).toBeUndefined();
  });
});

describe("sendRefusal on claims no tool made", () => {
  const codeHandedOver = [
    userMessage("код от госуслуг: 123456"),
    ...toolStep("browser_task", {
      note: "This errand now continues as run run-2 in the same browser.",
      runId: "run-2",
      status: "running",
    }),
  ];

  it.each([
    "код принял, ввёл — кабинет открылся, смотрю штрафы, налоги и срок загранника. отпишусь с результатом.",
    "запросил новый код — госуслуги должны прислать свежую смс на ваш номер. как придёт, скиньте его, и я сразу продолжу.",
    "залез в личный кабинет на госуслугах — смотрю штрафы, налоги и срок загранника.",
    "Продолжаю в том же браузере: адрес подтвердил, сейчас проверяю слот к 20:00.",
  ])("returns «%s» right after the run was handed work", (text) => {
    expect(refusal(codeHandedOver, text)).toEqual({ rewrite: "browser" });
  });

  it.each([
    "код передал в браузер — как страница его примет, пришлю штрафы, налоги и срок загранника.",
    "Код ещё не ввёл: запуск только получил его. Итог пришлю, как будет.",
    "В прошлый раз код ввёл, но он истёк — передал новый.",
    "ты подтвердил карточку — передал запуску.",
  ])("delivers «%s»", (text) => {
    expect(refusal(codeHandedOver, text)).toBeUndefined();
  });

  it("lets «ввёл» through once the tool typed the code itself", () => {
    const typed = [
      userMessage("код 123456"),
      ...toolStep("browser_task", {
        note: "The code went straight into the page, and the message was queued into the running errand as well.",
        runId: "run-2",
        status: "running",
      }),
    ];

    expect(refusal(typed, "код ввёл, жду, что покажет страница.")).toBe(
      undefined
    );
    expect(refusal(typed, "код ввёл — кабинет открылся.")).toEqual({
      rewrite: "browser",
    });
  });

  it("checks no browser claim in a turn a run's report opened", () => {
    const report = [
      userMessage(`${backgroundTurnMarker}\n\nBrowser run run-1 finished.`),
      ...toolStep("browser_task", { runId: "run-2", status: "running" }),
    ];

    expect(
      refusal(report, "Код ввёл, кабинет открылся — дальше смотрю налоги.")
    ).toBeUndefined();
  });

  it("returns a calendar slot no tool booked (d18)", () => {
    const history = [
      userMessage("поставь в календарь стоматолога в пятницу"),
      ...toolStep("gmail-search", { messages: [] }),
    ];

    expect(
      refusal(
        history,
        "Письма нет. Пока ставлю в календарь по умолчанию слот 11:00–12:00 на пятницу, 25 сентября, — поправлю, как назовёте точное время."
      )
    ).toEqual({ rewrite: "calendar" });
    expect(
      refusal(
        history,
        "Письма нет. Скажите время и клинику — поставлю в календарь."
      )
    ).toBeUndefined();
  });

  it("reads a list of what Bro does as no calendar claim", () => {
    // An introduction on DeepSeek went back for a rewrite twice over it.
    expect(
      refusal(
        [userMessage("сделай мне справку от врача")],
        "Привет, я Бро. Делаю за тебя скучное: ищу и сравниваю, разбираю почту, календарь и Google Диск, ставлю напоминания. С этой просьбой не помогу."
      )
    ).toBeUndefined();
  });

  it.each([
    "Записал: встреча с Артуром в пятницу в календаре.",
    "Добавил встречу, она уже в календаре.",
  ])("returns «%s» when no calendar tool ran (review #6)", (text) => {
    expect(
      refusal([userMessage("запиши встречу с Артуром в пятницу")], text)
    ).toEqual({ rewrite: "calendar" });
  });

  it("delivers a calendar event the apps tool created (review #11)", () => {
    const request = userMessage(
      "поставь встречу с Анной в четверг 15:00 в мой Outlook"
    );
    const outlook: ModelMessage[] = [
      request,
      {
        content: [
          {
            input: {
              action: "run",
              app: "outlook",
              tool: "OUTLOOK_CALENDAR_CREATE_EVENT",
            },
            toolCallId: "apps-1",
            toolName: "apps",
            type: "tool-call" as const,
          },
        ],
        role: "assistant" as const,
      },
      {
        content: [
          {
            output: {
              type: "json" as const,
              value: { result: { id: "event-1" }, status: "done" },
            },
            toolCallId: "apps-1",
            toolName: "apps",
            type: "tool-result" as const,
          },
        ],
        role: "tool" as const,
      },
    ];

    expect(
      refusal(outlook, "Добавил встречу в календарь Outlook на четверг 15:00.")
    ).toBeUndefined();
    // A spreadsheet row is no calendar event.
    const sheet = [request, ...toolStep("apps", { status: "done" })];
    expect(
      refusal(sheet, "Добавил встречу в календарь Outlook на четверг 15:00.")
    ).toEqual({ rewrite: "calendar" });
  });

  it("reads a sentence about the person's calendar as no claim", () => {
    expect(
      refusal(
        [userMessage("запомни, что по пятницам у меня зал")],
        "Записал: по пятницам у тебя в календаре зал, учту."
      )
    ).toBeUndefined();
  });

  it("delivers a calendar change the turn made (d15)", () => {
    const history = [
      userMessage("созвон с петровым в пятницу в 15:30, поставь"),
      ...toolStep("calendar-create-event", { created: true }),
    ];

    expect(
      refusal(
        history,
        "созвон с петровым в пятницу в 15:30 поставил в календарь."
      )
    ).toBeUndefined();
  });

  it("reads a past-tense calendar claim as an earlier turn's write", () => {
    const history = [
      userMessage("созвон с петровым в пятницу в 15:30, поставь"),
      ...toolStep("calendar-create-event", { created: true }),
      ...sendMessage("a", "Поставил."),
      userMessage("а созвон точно в календаре?"),
    ];

    expect(
      refusal(history, "Да, поставил в календарь на пятницу, 15:30.")
    ).toBeUndefined();
    expect(
      refusal(history, "Сейчас ставлю в календарь ещё раз на 15:30.")
    ).toEqual({ rewrite: "calendar" });
  });

  it("lets a claim through once the model kept it twice", () => {
    const claim = "код ввёл — кабинет открылся.";
    const rewritten = [
      ...codeHandedOver,
      ...sendMessage("a", claim, textOutput(rewriteSendNotice("browser"))),
      ...sendMessage("b", claim, textOutput(rewriteSendNotice("browser"))),
    ];

    expect(turnSends(rewritten).rewrites).toBe(2);
    expect(refusal(rewritten, claim)).toBeUndefined();
  });
});

describe("turnSends", () => {
  it("counts only what the current turn delivered", () => {
    const history = [
      userMessage("вчерашний вопрос"),
      ...sendMessage("old", "Готово"),
      userMessage("найди посылку"),
      ...sendMessage("a", "Ищу посылку"),
      frameworkMessage("context.instruction"),
      ...sendMessage("b", "Нашёл: она в Пулково"),
    ];

    expect(turnSends(history)).toMatchObject({
      delivered: [sent("Ищу посылку"), sent("Нашёл: она в Пулково")],
      rewrites: 0,
      skipped: 0,
      workSinceDelivery: false,
    });
    expect(turnMustEnd(history)).toBe(false);
  });

  it("notes other work since the last delivery, but not a reaction", () => {
    const acknowledged = [
      userMessage("найди посылку"),
      ...sendMessage("a", "Ищу посылку"),
      ...toolStep("react_to_message", { type: "thumbs_up" }),
    ];

    expect(turnSends(acknowledged).workSinceDelivery).toBe(false);
    expect(
      turnSends([
        ...acknowledged,
        ...toolStep("gmail-search", { messages: [] }),
      ]).workSinceDelivery
    ).toBe(true);
  });

  it("ignores a send that failed, was dropped or returned", () => {
    const history = [
      userMessage("оформи возврат"),
      ...sendMessage("a", "Оформляю возврат"),
      ...sendMessage(
        "b",
        "Оформляю возврат",
        textOutput(skippedSendNotice("duplicate"))
      ),
      ...sendMessage("c", "Не вышло", {
        type: "error-text",
        value: "invalid",
      }),
      ...sendMessage(
        "d",
        "Запросил код",
        textOutput(rewriteSendNotice("browser"))
      ),
    ];

    expect(turnSends(history)).toMatchObject({
      delivered: [sent("Оформляю возврат")],
      rewrites: 1,
      skipped: 1,
    });
  });

  it("never counts a refused send as reaching the person", () => {
    expect(sendReachedPerson(textOutput(skippedSendNotice("stale")))).toBe(
      false
    );
    expect(sendReachedPerson(textOutput(rewriteSendNotice("calendar")))).toBe(
      false
    );
    expect(sendReachedPerson(textOutput("submitted"))).toBe(true);
  });

  it("ends a turn after its first dropped send", () => {
    const once = [
      userMessage("оформи возврат"),
      ...sendMessage("a", "Оформляю возврат"),
    ];

    expect(turnMustEnd(once)).toBe(false);
    expect(
      turnMustEnd([
        ...once,
        ...sendMessage(
          "b",
          "Пока оформляю",
          textOutput(skippedSendNotice("stale"))
        ),
      ])
    ).toBe(true);
  });

  it("does not end a turn over a send returned for a rewrite", () => {
    expect(
      turnMustEnd([
        userMessage("код 1234"),
        ...sendMessage(
          "a",
          "Ввёл код",
          textOutput(rewriteSendNotice("browser"))
        ),
      ])
    ).toBe(false);
  });

  it("ends a turn that reached the message limit", () => {
    const sends = Array.from({ length: turnMessageLimit }, (_, index) =>
      sendMessage(
        `call-${String(index)}`,
        `Вопрос викторины номер ${String(index)}`
      )
    ).flat();

    expect(turnMustEnd([userMessage("давай викторину"), ...sends])).toBe(true);
    expect(
      turnMustEnd([userMessage("давай викторину"), ...sends.slice(2)])
    ).toBe(false);
  });

  it("starts counting again when the person writes", () => {
    const sends = Array.from({ length: turnMessageLimit }, (_, index) =>
      sendMessage(
        `call-${String(index)}`,
        `Вопрос викторины номер ${String(index)}`
      )
    ).flat();

    expect(
      turnMustEnd([
        userMessage("давай викторину"),
        ...sends,
        userMessage("ещё"),
      ])
    ).toBe(false);
  });

  it("skips a send whose attachment is a relative artifact path", () => {
    // A browser result offers `/artifacts/<id>` images; a model that put one
    // into `attachments` once made this parse throw «Invalid URL» and failed
    // the turn's model selection.
    const history = [
      userMessage("найди машину"),
      ...sendMessage("call-1", "Вот машина", undefined, [
        { kind: "image", url: "/artifacts/abc" },
      ]),
    ];

    expect(turnSends(history)).toMatchObject({ delivered: [], skipped: 0 });
    expect(() => turnMustEnd(history)).not.toThrow();
  });
});

function refusal(history: readonly ModelMessage[], text: string) {
  return sendRefusal(message(text), turnSends(history));
}

function message(text: string) {
  return { kind: "message" as const, text };
}

function photo(url: string) {
  return {
    attachments: [{ kind: "image" as const, url }],
    kind: "message" as const,
    text: "Вот ещё",
  };
}

function sent(text: string) {
  return sentMessageOf(message(text));
}

function textOutput(value: string): ToolResultPart["output"] {
  return { type: "text", value };
}

function userMessage(text: string): ModelMessage {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

function frameworkMessage(kind: string): ModelMessage {
  return Object.assign({ content: "context", role: "user" as const }, { kind });
}

let toolSteps = 0;

function toolStep(
  toolName: string,
  value: Extract<ToolResultPart["output"], { type: "json" }>["value"]
): ModelMessage[] {
  toolSteps += 1;
  const toolCallId = `${toolName}-${String(toolSteps)}`;
  return [
    {
      content: [{ input: {}, toolCallId, toolName, type: "tool-call" }],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "json", value },
          toolCallId,
          toolName,
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
}

function sendMessage(
  toolCallId: string,
  text: string,
  output: ToolResultPart["output"] = { type: "text", value: "submitted" },
  attachments?: readonly { kind: string; url: string }[]
): ModelMessage[] {
  return sendInput(toolCallId, message(text), output, attachments);
}

function sendInput(
  toolCallId: string,
  input: ReturnType<typeof message> | ReturnType<typeof photo>,
  output: ToolResultPart["output"] = { type: "text", value: "submitted" },
  attachments?: readonly { kind: string; url: string }[]
): ModelMessage[] {
  return [
    {
      content: [
        {
          input: attachments === undefined ? input : { ...input, attachments },
          toolCallId,
          toolName: "send_message",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        { output, toolCallId, toolName: "send_message", type: "tool-result" },
      ],
      role: "tool",
    },
  ];
}
