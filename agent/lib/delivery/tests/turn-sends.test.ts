import type { JSONValue, ModelMessage, ToolResultPart } from "ai";
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
 * Turns from the production benchmark of 25.09.2026 (gpt-6-luna): what went
 * out after the first message still passed as news — a name in another case,
 * a detail of the errand the first message left out, a question wrapped in
 * the answer told again.
 */
describe("sendRefusal on the benchmark of 25.09", () => {
  const barberRequest = userMessage(
    "скинь адрес того барбера плз, я забыл кк он называеца"
  );
  const barberAnswer =
    "Похоже, это The Barber Club: Профсоюзная улица, 11/11, вход с улицы Кржижановского. Но имя Артура там не подтвердилось — нашёл только отдельного барбера Артура в Мытищах, так что это может быть не тот мастер.\nhttps://thebarberclub.ru/";

  it.each([
    "Похоже, это The Barber Club: Профсоюзная улица, 11/11, вход с улицы Кржижановского. Но подтвердить, что там работает Артур, не удалось. https://thebarberclub.ru/",
    "Похоже, барбершоп называется The Barber Club: Профсоюзная улица, 11/11, вход с улицы Кржижановского. Но что там работает Артур, подтвердить не удалось. https://thebarberclub.ru/",
  ])("drops the address said again with «Артур» for «Артура» (d15)", (text) => {
    const history = [
      barberRequest,
      ...toolStep("web_search", { results: [] }),
      ...sendMessage("address", barberAnswer),
    ];

    expect(refusal(history, text)).toEqual({ skipped: "stale" });
  });

  it("keeps two names that share only their first letters apart", () => {
    const history = [
      userMessage("кто завтра придёт?"),
      ...sendMessage("first", "Мария придёт завтра в 10:00."),
    ];

    expect(refusal(history, "Марина придёт завтра в 10:00.")).toBeUndefined();
  });

  it.each([
    [
      "Виктории after Виктору",
      "Напиши Виктору и Виктории, что встреча в 15:00",
      "Письмо Виктору отправлено: встреча в 15:00.",
      "Письмо Виктории отправлено: встреча в 15:00.",
    ],
    [
      "Виктория after Виктор",
      "кто подтвердил встречу?",
      "Виктор подтвердил встречу завтра в 10:00.",
      "Виктория подтвердила встречу завтра в 10:00.",
    ],
    [
      "Виктория named inside the sentence",
      "кто подтвердил встречу?",
      "Виктор подтвердил встречу завтра в 10:00.",
      "Также подтвердила Виктория.",
    ],
    [
      "Валентина after Валентин, both named by the person",
      "Предупреди охрану, что завтра в 10:00 придут Валентин и Валентина",
      "Валентин придёт завтра в 10:00, я предупредил охрану.",
      "Валентина придёт завтра в 10:00, я предупредил охрану.",
    ],
    [
      "Эмилия after Эмиль",
      "кто завтра придёт?",
      "Эмиль придёт завтра в 10:00, я предупредил охрану.",
      "Эмилия придёт завтра в 10:00, я предупредил охрану.",
    ],
    [
      "Леня after Лена",
      "кто завтра придёт?",
      "Лена придёт завтра в 10:00, я предупредил охрану.",
      "Леня придёт завтра в 10:00, я предупредил охрану.",
    ],
  ])(
    "delivers %s: another person, not another case",
    (_case, ask, first, second) => {
      const history = [
        userMessage(ask),
        ...toolStep("gmail-send", { id: "m-1" }),
        ...toolStep("gmail-send", { id: "m-2" }),
        ...sendMessage("first", first),
      ];

      expect(refusal(history, second)).toBeUndefined();
    }
  );

  it.each([
    [
      "Александра after Александр",
      "Александр подтвердил встречу завтра в 10:00.",
      "Александра подтвердила встречу завтра в 10:00.",
    ],
    [
      "Евгения after Евгений",
      "Евгений подтвердил встречу завтра в 10:00.",
      "Евгения подтвердила встречу завтра в 10:00.",
    ],
    [
      "Александра after Александр, named inside the sentence",
      "Встречу завтра в 10:00 подтвердил Александр.",
      "Встречу завтра в 10:00 подтвердила и Александра.",
    ],
  ])(
    "delivers %s from the calendar: the verbs say a man and a woman",
    (_case, first, second) => {
      const history = [
        userMessage("кто подтвердил встречу?"),
        ...toolStep("calendar-list-events", { events: [] }),
        ...sendMessage("first", first),
      ];

      expect(refusal(history, second)).toBeUndefined();
    }
  );

  it.each([
    [
      "Лавку after Лавке",
      "Запустил поручение на Яндекс Лавке.",
      "Поручение передано в Яндекс Лавку, сайт пока ничего не оформлял.",
    ],
    [
      "Профсоюзная after Профсоюзной",
      "Барбершоп на Профсоюзной улице, 11/11.",
      "Это барбершоп на улице Профсоюзная, 11/11, рядом с метро.",
    ],
    [
      "Шереметьеве after Шереметьево",
      "Вылет из Шереметьево в 08:40, терминал B.",
      "Вылетаете в 08:40 из Шереметьеве, терминал B.",
    ],
    [
      "Иванов after Ивановым",
      "Договорился с Ивановым о встрече в 15:00.",
      "Встречу в 15:00 подтвердил Иванов.",
    ],
  ])("still reads %s as the same name", (_case, first, second) => {
    const history = [
      userMessage("что там?"),
      ...toolStep("web_search", { results: [] }),
      ...sendMessage("first", first),
    ];

    expect(refusal(history, second)).toEqual({ skipped: "stale" });
  });

  it.each([
    [
      "the name in another case",
      "Похоже, это The Barber Club: Профсоюзная улица, 11/11, вход с улицы Кржижановского. Но имя Артура там не подтвердилось.",
      "Похоже, это The Barber Club: Профсоюзная улица, 11/11, вход с улицы Кржижановского. Но мастер Артур там не подтвердился.",
    ],
    [
      "the name moved and declined",
      "Записал вас к Артуру на завтра, 26 сентября, в 19:00: барбершоп The Barber Club, Профсоюзная улица, 11/11.",
      "Записал вас на завтра, 26 сентября, в 19:00 у Артура: барбершоп The Barber Club, Профсоюзная улица, 11/11.",
    ],
  ])("drops a near copy with %s (d15)", (_case, first, second) => {
    const history = [
      barberRequest,
      // The search luna made in d15.
      ...toolStep(
        "web_search",
        { results: [] },
        { query: "барбершоп Артур Профсоюзная Москва адрес", sites: [] }
      ),
      ...sendMessage("address", first),
    ];

    expect(refusal(history, second)).toEqual({ skipped: "duplicate" });
  });

  it.each([
    [
      "Ивановой after Иванову",
      "Отправил письмо Иванову: встреча переносится на пятницу.",
      "Отправил письмо Ивановой: встреча переносится на пятницу.",
    ],
    [
      "Александре after Александру",
      "Отправил письмо Александру: встреча переносится на пятницу.",
      "Отправил письмо Александре: встреча переносится на пятницу.",
    ],
    [
      "Евгении after Евгению",
      "Отправил письмо Евгению: встреча переносится на пятницу.",
      "Отправил письмо Евгении: встреча переносится на пятницу.",
    ],
    [
      "на Тверском after на Тверской",
      "Встреча в кафе на Тверской в 15:00, адрес отправил всем.",
      "Встреча в кафе на Тверском в 15:00, адрес отправил всем.",
    ],
  ])(
    "delivers %s: names the turn never used are compared as written",
    (_case, first, second) => {
      const history = [
        userMessage(
          "Разошли всем из вчерашнего письма, что встреча переносится на пятницу"
        ),
        ...toolStep("gmail-send", { id: "m-1" }),
        ...sendMessage("first", first),
        ...toolStep("gmail-send", { id: "m-2" }),
      ];

      expect(refusal(history, second)).toBeUndefined();
      // Without the second letter in between, too.
      expect(refusal(history.slice(0, -2), second)).toBeUndefined();
    }
  );

  const groceries = userMessage(
    "закажи продукты к восьми вечера: молоко 3,2, десяток яиц, 2 авокадо, куриное филе около кило и чего-нибудь к чаю. если чего-то нет, замени похожим, но скажи что заменил"
  );
  /** The call luna made in d05, as the event log kept it. */
  const groceriesErrand = {
    allowPayment: false,
    allowSubmit: false,
    collectImages: false,
    deliveryAddress: true,
    site: "https://lavka.yandex.ru",
    submission: {
      amount: "Итог пока не найден",
      chargeRub: 0,
      forWhom: "Савелий Соловьев",
      items: [
        "Молоко 3,2%",
        "Яйца, 10 шт.",
        "Авокадо × 2",
        "Куриное филе, около 1 кг",
        "Что-нибудь к чаю",
      ],
      kind: "order",
      personalData: [],
      what: "Заказ продуктов с доставкой к 20:00: молоко 3,2%, десяток яиц, 2 авокадо, около 1 кг куриного филе и что-нибудь к чаю; если чего-то нет, заменить похожим и сообщить замены",
      when: "25 сентября 2026, к 20:00",
      where: "Яндекс Лавка (lavka.yandex.ru)",
    },
    task: "Закажите доставкой к 20:00 сегодня в Москве по сохранённому адресу: молоко 3,2%, десяток яиц, 2 авокадо, куриное филе около 1 кг и что-нибудь к чаю. Если чего-то нет, выберите похожую замену и сообщите, что именно заменили. Подберите товары и доведите до финального шага, сообщите полный состав, замены, слот, сборы и общую стоимость; не оформляйте и не оплачивайте без моей карточки. Если в Лавке недоступно, проверьте Самокат или Перекрёсток.",
  };
  const groceriesStart = browserStep(
    "start",
    { runId: "run-1", status: "running" },
    groceriesErrand
  );
  const errandStarted = [groceries, ...groceriesStart];
  const errandStatus =
    "Запустил заказ продуктов с доставкой к 20:00 на сохранённый адрес. Когда соберу корзину, пришлю точный состав, цену и все замены на подтверждение; пока ничего не оформлено.";

  it("delivers one message about the errand it started (d05)", () => {
    expect(refusal(errandStarted, errandStatus)).toBeUndefined();
  });

  const secondStatuses = [
    "Запустил поручение на Яндекс Лавке; заказ ещё не оформлен. Уточню: назвал доставку к 20:00 сегодня, 25 сентября, на сохранённый адрес в Москве.",
    "Заказал не я: Яндекс Лавка ещё ничего не получила — браузерный запуск только поставлен в очередь. Как только соберу корзину и узнаю цену и замены, пришлю её вам на подтверждение.",
    "Поручение на заказ передано в Яндекс Лавку; сайт пока ничего не оформлял. Пришлю найденную корзину, цену и замены, когда запуск вернёт результат.",
  ];

  it.each(secondStatuses)(
    "drops a second message about the same errand (d05)",
    (text) => {
      const told = [...errandStarted, ...sendMessage("started", errandStatus)];

      expect(refusal(told, text)).toEqual({ skipped: "started" });
      expect(skippedSendNotice("started")).toContain("end the turn now");
    }
  );

  it.each([
    ["list_orders", { orders: [] }],
    ["web_search", { results: [] }],
    ["workstreams__read", { id: "groceries", revision: 1 }],
  ])(
    "drops it when %s ran before the errand started (d02, d04, d15)",
    (toolName, value) => {
      const told = [
        groceries,
        ...toolStep(toolName, value),
        ...groceriesStart,
        ...sendMessage("started", errandStatus),
      ];

      for (const text of secondStatuses) {
        expect(refusal(told, text)).toEqual({ skipped: "started" });
      }
    }
  );

  it("drops it after a status check that found the run still at work", () => {
    const polled = [
      ...errandStarted,
      ...sendMessage("started", errandStatus),
      ...browserStep("status", { runId: "run-1", status: "running" }),
    ];

    expect(
      refusal(
        polled,
        "Запуск ещё собирает корзину в Яндекс Лавке, заказ не оформлен."
      )
    ).toEqual({ skipped: "started" });
  });

  it.each([
    [
      "a question the first message did not ask",
      [],
      "Если молока 3,2 не будет, взять 2,5 или 3,5?",
    ],
    [
      "what other work of the turn did",
      toolStep("schedules-create", { id: "job-1", status: "active" }),
      "И напоминание разобрать пакеты поставил на 20:30.",
    ],
    [
      "another errand the turn started since",
      browserStep("start", { runId: "run-2", status: "running" }),
      "Столик в «Пушкине» на 21:00 тоже ищу — пришлю, что найду.",
    ],
    [
      "an errand that failed to go on",
      browserStep("continue", { status: "unavailable" }),
      "Браузерный сервис сейчас недоступен, заказ не оформится — попробую позже.",
    ],
  ])("still delivers %s after the errand's message", (_case, work, text) => {
    const told = [
      ...errandStarted,
      ...sendMessage("started", errandStatus),
      ...work,
    ];

    expect(refusal(told, text)).toBeUndefined();
  });

  const ticketsAndWeather = userMessage(
    "Найди билеты в Сочи на выходные и скажи, какая там погода"
  );
  const ticketsStart = browserStep(
    "start",
    { runId: "run-1", status: "running" },
    {
      site: "https://www.tutu.ru",
      task: "Найдите билеты Москва — Сочи на выходные, 27–28 сентября, на Туту: поезд или самолёт, пришлите варианты с ценами.",
    }
  );
  const ticketsStatus =
    "Запустил поиск билетов в Сочи на выходные — пришлю варианты, как найду.";
  const weather =
    "Погода в Сочи на выходных: днём до +24, солнечно, вечером +17.";

  it.each([
    [
      "the weather after the errand's message",
      [
        ticketsAndWeather,
        ...inOneStep(ticketsStart, toolStep("web_search", { results: [] })),
        ...sendMessage("tickets", ticketsStatus),
      ],
      weather,
    ],
    [
      "the errand's message after the weather",
      [
        ticketsAndWeather,
        ...inOneStep(ticketsStart, toolStep("web_search", { results: [] })),
        ...sendMessage("weather", weather),
      ],
      "Билеты Москва — Сочи на 27–28 сентября ищу в браузере, пришлю варианты.",
    ],
    [
      "the weather found a step before the errand started",
      [
        ticketsAndWeather,
        ...toolStep("web_search", { results: [] }),
        ...ticketsStart,
        ...sendMessage("tickets", ticketsStatus),
      ],
      weather,
    ],
    [
      "the answer to a question asked with a steer",
      [
        userMessage("Поменяй на 20:00. А Пушкин работает до скольки?"),
        ...inOneStep(
          browserStep("continue", { runId: "run-2", status: "running" }),
          toolStep("web_search", { results: [] })
        ),
        ...sendMessage("steer", "Передал: переносим бронь на 20:00."),
      ],
      "«Пушкин» работает до 00:00, кухня — до 23:00.",
    ],
    [
      "a calendar entry made with the errand's start",
      [
        userMessage(
          "закажи продукты к восьми и поставь в календарь принять доставку"
        ),
        ...inOneStep(
          browserStep("start", { runId: "run-1", status: "running" }),
          toolStep("calendar-create-event", { id: "event-1" })
        ),
        ...sendMessage("started", errandStatus),
      ],
      "В календарь поставил «Принять доставку» на 19:50.",
    ],
  ])(
    "delivers %s: other work of the turn is news of its own",
    (_case, history, text) => {
      expect(refusal(history, text)).toBeUndefined();
    }
  );

  const dinnerSearch = toolStep("web_search", {
    results:
      "1. Авокадо, ресторан, Чистопрудный бул., 12, корп. 2, Москва — Яндекс Карты\nhttps://yandex.ru/maps/org/avokado/1099046369/\nРесторан «Авокадо» специализируется на вегетарианской, веганской и сыроедческой кухне.",
  });
  const dinnerBooking = browserStep(
    "start",
    { runId: "run-7", status: "running" },
    {
      site: "https://yandex.ru/maps/org/avokado/1099046369/",
      task: "Забронируйте столик в «Авокадо», Чистопрудный бульвар, 12, корп. 2, на 26 сентября, 19:30, на четверых.",
    }
  );
  const barberSearch = toolStep("web_search", {
    results:
      "1. Барбершоп The Barber Club | Мужские стрижки\nhttps://thebarberclub.ru/\nг. Москва, ул. Профсоюзная, 11/11, вход с улицы Кржижановского",
  });
  const barberBooking = browserStep(
    "start",
    { runId: "run-8", status: "running" },
    {
      site: "https://thebarberclub.ru/",
      task: "Запишите на 26 сентября, 19:00, к барберу Артуру в The Barber Club, Профсоюзная улица, 11/11.",
    }
  );

  it.each([
    [
      "the restaurant, searched and started in two steps",
      [
        userMessage(
          "найди, где поужинать завтра в 19:30 на четверых у чистых прудов, не сетевое, и забронируй"
        ),
        ...dinnerSearch,
        ...dinnerBooking,
        ...sendMessage(
          "started",
          "Запустил бронь, пришлю подтверждение, как будет готово."
        ),
      ],
      "Бронирую «Авокадо», Чистопрудный бульвар, 12, корп. 2: полностью вегетарианское меню.",
    ],
    [
      "the restaurant, searched and started in one step",
      [
        userMessage(
          "найди, где поужинать завтра в 19:30 на четверых у чистых прудов, не сетевое, и забронируй"
        ),
        ...inOneStep(dinnerSearch, dinnerBooking),
        ...sendMessage(
          "started",
          "Запустил бронь, пришлю подтверждение, как будет готово."
        ),
      ],
      "Бронирую «Авокадо», Чистопрудный бульвар, 12, корп. 2: полностью вегетарианское меню.",
    ],
    [
      "the barbershop",
      [
        userMessage(
          "запиши меня в барбершоп на профсоюзной к артуру на завтра в 19:00"
        ),
        ...barberSearch,
        ...barberBooking,
        ...sendMessage("started", "Запустил запись, пришлю подтверждение."),
      ],
      "Нашёл The Barber Club: Профсоюзная улица, 11/11. Записываю туда на 19:00.",
    ],
  ])("delivers %s the model picked from a search", (_case, history, text) => {
    expect(refusal(history, text)).toBeUndefined();
  });

  const taxiStart = browserStep(
    "start",
    { runId: "run-9", status: "running" },
    {
      site: "https://taxi.yandex.ru",
      task: "Закажите такси до офиса на 9:00 утра и пришлите машину и цену.",
    }
  );
  const taxiStatus =
    "Запустил заказ такси до офиса на 9:00, пришлю машину и цену.";

  it.each([
    [
      "the letter the person asked to check",
      [
        userMessage(
          "Закажи такси до офиса на 9 утра и проверь, пришло ли письмо от Иванова"
        ),
        ...inOneStep(taxiStart, toolStep("gmail-search", { messages: [] })),
        ...sendMessage("taxi", taxiStatus),
      ],
      "Письмо от Иванова есть: просит перенести встречу на четверг.",
    ],
    [
      "a gift idea the person asked for",
      [
        userMessage(
          "Закажи такси до офиса на 9 утра и подскажи, что подарить Маше"
        ),
        ...taxiStart,
        ...sendMessage("taxi", taxiStatus),
      ],
      "А Маше можно подарить сертификат в спа или хорошие наушники.",
    ],
    [
      "whether the person makes it in time",
      [
        userMessage(
          "Закажи такси до офиса на 9 утра и скажи, успею ли я к 10:00 в Шереметьево"
        ),
        ...taxiStart,
        ...sendMessage("taxi", taxiStatus),
      ],
      "К 10:00 в Шереметьево успеешь, запас есть.",
    ],
    [
      "the answer to a question asked with a steer",
      [
        userMessage("Поменяй на 20:00. А Пушкин работает до полуночи?"),
        ...browserStep(
          "continue",
          { runId: "run-2", status: "running" },
          { task: "Поменяй на 20:00. А Пушкин работает до полуночи?" }
        ),
        ...sendMessage("steer", "Передал: переносим бронь на 20:00."),
      ],
      "Да, «Пушкин» открыт до полуночи.",
    ],
  ])(
    "delivers %s after the errand's message: it is not about the errand",
    (_case, history, text) => {
      expect(refusal(history, text)).toBeUndefined();
    }
  );

  it("delivers the second errand's message after the first's (two starts in one step)", () => {
    const both = [
      userMessage(
        "Закажи такси до Шереметьево на 18:00 и забронируй столик в Пушкине на 21:00 на двоих"
      ),
      ...inOneStep(
        browserStep(
          "start",
          { runId: "run-12", status: "running" },
          { task: "Закажите такси до Шереметьево на 18:00." }
        ),
        browserStep(
          "start",
          { runId: "run-13", status: "running" },
          { task: "Забронируйте столик в «Пушкине» на 21:00 на двоих." }
        )
      ),
      ...sendMessage(
        "taxi",
        "Такси до Шереметьево на 18:00 заказываю, пришлю машину."
      ),
    ];

    expect(
      refusal(
        both,
        "Столик в «Пушкине» на 21:00 на двоих тоже ищу, пришлю подтверждение."
      )
    ).toBeUndefined();
  });

  it("delivers the saved address the model gave the errand", () => {
    const taxi = [
      userMessage("Закажи такси на работу к 9 утра"),
      ...browserStep(
        "start",
        { runId: "run-14", status: "running" },
        {
          task: "Закажите такси от Тверской, 7 до Профсоюзной, 11, тариф Комфорт, подача к 9:00.",
        }
      ),
      ...sendMessage("taxi", "Запустил заказ такси к 9:00, пришлю машину."),
    ];

    expect(
      refusal(
        taxi,
        "Уточню: еду от Тверской, 7 до Профсоюзной, 11, тариф Комфорт."
      )
    ).toBeUndefined();
  });

  it("gives each errand started in one step its own message", () => {
    const both = [
      userMessage(
        "Закажи такси до офиса на 9 утра и забронируй столик в Пушкине на 20:00"
      ),
      ...inOneStep(
        taxiStart,
        browserStep(
          "start",
          { runId: "run-10", status: "running" },
          {
            site: "https://cafe-pushkin.ru",
            task: "Забронируйте столик в «Пушкине» на 20:00 на двоих.",
          }
        )
      ),
      ...sendMessage("taxi", taxiStatus),
    ];
    const table =
      "И запустил бронь столика в «Пушкине» на 20:00 — пришлю подтверждение.";

    expect(refusal(both, table)).toBeUndefined();
    // Both have had their message, so a third is dropped.
    const third = refusal(
      [...both, ...sendMessage("table", table)],
      "Оба поручения переданы в браузер: такси и столик в «Пушкине»."
    );
    expect(third && "skipped" in third).toBe(true);
  });

  it("still gives the errand one message when other work came with it", () => {
    const history = [
      ticketsAndWeather,
      ...inOneStep(ticketsStart, toolStep("web_search", { results: [] })),
      ...sendMessage("tickets", ticketsStatus),
      ...sendMessage("weather", weather),
    ];

    expect(
      refusal(
        history,
        "Поиск билетов в Сочи идёт в браузере на Туту, пришлю варианты с ценами."
      )
    ).toEqual({ skipped: "started" });
  });

  const deliveryInCalendar = [
    userMessage(
      "закажи продукты к восьми и поставь в календарь принять доставку"
    ),
    ...groceriesStart,
    ...sendMessage("started", errandStatus),
  ];

  const deliveryReminder = [
    userMessage("закажи продукты к восьми и напомни принять доставку"),
    ...groceriesStart,
    ...sendMessage("started", errandStatus),
  ];

  const rateSearch = toolStep("web_search", {
    results: "Официальный курс доллара ЦБ РФ на 26 сентября — 92,4 ₽.",
  });

  it.each([
    [
      "поставь в календарь приём доставки на 19:50 и скажи курс доллара",
      "И ещё сейчас поставлю приём доставки в календарь.",
      "calendar-create-event",
      "В календарь поставил приём доставки на 19:50.",
    ],
    [
      "напомни в 20:00 позвонить маме и скажи курс доллара",
      "Сейчас поставлю напоминание позвонить маме.",
      "schedules-create",
      "Напоминание позвонить маме поставил на 20:00.",
    ],
  ])(
    "returns a step the person asked for (%s), announced instead of taken",
    (request, text, toolName, result) => {
      const history = [
        userMessage(request),
        ...rateSearch,
        ...sendMessage("rate", "Курс доллара — 92,4 ₽."),
      ];

      expect(refusal(history, text)).toEqual({ rewrite: "announced" });
      expect(rewriteSendNotice("announced")).toContain(
        "Take the step now with its tool"
      );
      const entered = [
        ...history,
        ...sendMessage(
          "announced",
          text,
          textOutput(rewriteSendNotice("announced"))
        ),
        ...toolStep(toolName, { id: "step-1" }),
      ];
      expect(turnMustEnd(entered)).toBe(false);
      expect(refusal(entered, result)).toBeUndefined();
    }
  );

  it("never has a step taken now that waits on the run the turn started", () => {
    const dentist = [
      userMessage("Запиши меня к стоматологу на пятницу и поставь в календарь"),
      ...browserStep(
        "start",
        { runId: "run-11", status: "running" },
        { task: "Запишите к стоматологу на пятницу, 2 октября." }
      ),
      ...sendMessage(
        "started",
        "Запустил запись к стоматологу на пятницу. Пришлю, на какое время записали."
      ),
    ];
    const refused = refusal(
      dentist,
      "Время пока не знаю. Поставлю в календарь визит к стоматологу."
    );

    expect(refused && "skipped" in refused).toBe(true);
    for (const text of [
      "И ещё сейчас поставлю приём доставки в календарь.",
      "Сейчас поставлю напоминание принять доставку.",
    ]) {
      for (const history of [deliveryInCalendar, deliveryReminder]) {
        const held = refusal(history, text);
        expect(held && "skipped" in held).toBe(true);
      }
    }
  });

  const deferredSteps = [
    "Поставлю доставку в календарь, как придёт подтверждение заказа.",
    "Приём доставки поставлю в календарь после оплаты.",
    "Как заказ оформится, поставлю доставку в календарь.",
    "Потом добавлю приём доставки в календарь.",
    "Поставлю напоминание, как придёт корзина.",
  ];

  it.each(deferredSteps)(
    "never has «%s», a step put off until later, taken now",
    (text) => {
      const ordered = [
        userMessage("закажи продукты к восьми"),
        ...groceriesStart,
        ...sendMessage("started", errandStatus),
      ];

      for (const history of [ordered, deliveryInCalendar, deliveryReminder]) {
        const refused = refusal(history, text);
        expect(refused && "skipped" in refused).toBe(true);
      }
    }
  );

  it("never has a step nobody asked for taken now", () => {
    const ordered = [
      userMessage("закажи продукты к восьми"),
      ...groceriesStart,
      ...sendMessage("started", errandStatus),
    ];

    expect(
      refusal(ordered, "И ещё сейчас поставлю приём доставки в календарь.")
    ).toEqual({ skipped: "stale" });
  });

  it("still drops a promise that waits on the person (d18)", () => {
    expect(
      refusal(
        deliveryInCalendar,
        "Назовите время доставки — поставлю приём в календарь."
      )
    ).toEqual({ skipped: "stale" });
  });

  it("leaves the turn open after the first message dropped about the errand", () => {
    const dropped = [
      ...deliveryInCalendar,
      ...sendMessage(
        "again",
        "Заказ в Лавке собирается, пришлю корзину.",
        textOutput(skippedSendNotice("started"))
      ),
    ];

    expect(skippedSendNotice("started")).toContain("do it now with its tool");
    expect(turnMustEnd(dropped)).toBe(false);
    // A second one ends the turn.
    expect(
      turnMustEnd([
        ...dropped,
        ...sendMessage(
          "once-more",
          "Заказ в Лавке собирается, корзину пришлю.",
          textOutput(skippedSendNotice("started"))
        ),
      ])
    ).toBe(true);
  });

  it("leaves a turn a browser report opened to its own rule", () => {
    const report = [
      userMessage(`${backgroundTurnMarker}\n\nBrowser run run-1 finished.`),
      ...browserStep("continue", { runId: "run-2", status: "running" }),
      ...sendMessage("heading", "Вот что нашёл:"),
    ];

    expect(
      refusal(report, "Сапсан 18:40 за 5 200 ₽ и Ласточка 19:10 за 3 100 ₽.")
    ).toBeUndefined();
  });

  const dinner = [
    userMessage(
      "нужно где поужинать завтра в 19:30 на четверых, пешком от чистых прудов. один вегетарианец, не сетевое, до 2500 на человека"
    ),
    ...toolStep("web_search", { results: [] }),
    ...toolStep("route_time", { routes: [] }),
  ];
  const twoPlaces =
    "Лучший вариант — «Авокадо», Чистопрудный бульвар, 12, корп. 2: полностью вегетарианское меню, так что гостю-вегетарианцу будет проще всего; блюдо найдётся и для остальных. Второй вариант — «Циники», Богословский пер., 3/15с1: веганское бистро с рейтингом 4,8; карточка 2ГИС показывает два филиала, поэтому условие «не сетевое» не проходит. «Авокадо» выглядит отдельным рестораном, но средний чек и часы именно на завтра в 19:30 не удалось надёжно подтвердить. Свободный стол на четверых тоже не проверял; пешее время маршрутный сервис не нашёл, поэтому минуты не буду выдумывать.\nhttps://yandex.ru/maps/org/avokado/1099046369/";
  const offer =
    "Забронировать на завтра, 26 сентября, на 19:30, на четверых в «Авокадо»?";
  const retold = `«Авокадо» — единственный найденный вариант, который подходит по типу кухни и адресу, но подтвердить бюджет до 2 500 ₽ на человека не получилось. ${offer}`;

  const retoldAsIs = `«Авокадо», Чистопрудный бульвар, 12, корп. 2: полностью вегетарианское меню, средний чек до 2 500 ₽. ${offer}`;

  it("returns a question wrapped in the answer told again (d03)", () => {
    const answered = [...dinner, ...sendMessage("places", twoPlaces)];

    expect(refusal(answered, retoldAsIs)).toEqual({ rewrite: "restated" });
    expect(rewriteSendNotice("restated")).toContain("Send the question alone");
    // The question alone is news.
    const returned = [
      ...answered,
      ...sendMessage(
        "retold",
        retoldAsIs,
        textOutput(rewriteSendNotice("restated"))
      ),
    ];
    expect(refusal(returned, offer)).toBeUndefined();
  });

  it("delivers a question next to what it says anew about a place", () => {
    const found = [
      userMessage("Где поужинать сегодня у Чистых прудов?"),
      ...toolStep("web_search", { results: [] }),
      ...sendMessage(
        "places",
        "Нашёл два места: «Пушкин» на Тверском бульваре, 26 и «Авокадо» на Чистопрудном бульваре, 12."
      ),
    ];

    expect(
      refusal(
        found,
        "«Пушкин» сегодня закрыт на спецобслуживание, так что остаётся «Авокадо». Бронировать?"
      )
    ).toBeUndefined();
    // The d03 retelling in other words is delivered too, as it was before.
    const answered = [...dinner, ...sendMessage("places", twoPlaces)];
    expect(refusal(answered, retold)).toBeUndefined();
  });

  it("returns it when the person asked their question with limits in it (d03)", () => {
    const asked = [
      userMessage(
        "где поужинать завтра в 19:30 на четверых пешком от чистых прудов, чтобы не сетевое и до 2500 на человека?"
      ),
      ...toolStep("web_search", { results: [] }),
      ...toolStep("route_time", { routes: [] }),
      ...sendMessage("places", twoPlaces),
    ];

    expect(refusal(asked, retoldAsIs)).toEqual({ rewrite: "restated" });
  });

  it("drops the answer sent again after it went out in one message (d03)", () => {
    const answered = [
      ...dinner,
      ...sendMessage("places", `${twoPlaces}\n\n${retold}`),
    ];

    expect(
      refusal(
        answered,
        "Лучший вариант — «Авокадо», Чистопрудный бульвар, 12, корп. 2: полностью вегетарианское меню, удобно для всей компании. Но я не подтвердил ни чек до 2 500 ₽ на человека, ни пешее время; «Циники» исключил — у них два филиала. Свободный стол тоже не проверял.\nhttps://yandex.ru/maps/org/avokado/1099046369/\n\nЗабронировать «Авокадо» на завтра, 26 сентября, в 19:30 на четверых?"
      )
    ).toEqual({ skipped: "stale" });
  });

  it.each([
    [
      "a lead-in that names nothing",
      "Уточни одну вещь: бронировать на 19:30 или на 20:00? Как скажешь — займусь.",
    ],
    [
      "a new fact next to the question",
      "У «Авокадо» есть веранда на 8 мест с видом на пруд. Бронировать там?",
    ],
  ])("delivers a question with %s", (_case, text) => {
    const answered = [...dinner, ...sendMessage("places", twoPlaces)];

    expect(refusal(answered, text)).toBeUndefined();
  });

  it("delivers a correction around the question", () => {
    const answered = [...dinner, ...sendMessage("places", twoPlaces)];

    expect(
      refusal(
        answered,
        "Поправлю: у «Авокадо» средний чек до 2 500 ₽ на человека, я ошибся. Забронировать на завтра в 19:30?"
      )
    ).toBeUndefined();
  });

  it("delivers a retold question once the turn did more work", () => {
    const checked = [
      ...dinner,
      ...sendMessage("places", twoPlaces),
      ...toolStep("web_fetch", { text: "…" }),
    ];

    expect(refusal(checked, retold)).toBeUndefined();
  });

  it("delivers the answer to what the person asked about, around an offer", () => {
    const hermitage = [
      userMessage(
        "Сколько стоит билет в Эрмитаж и успею ли я к 18:00? Если да — купи"
      ),
      ...toolStep("web_search", { results: [] }),
      ...sendMessage("price", "Билет в Эрмитаж стоит 500 ₽."),
    ];

    expect(
      refusal(hermitage, "В 18:00 Эрмитаж ещё открыт, успеете. Купить билет?")
    ).toBeUndefined();
  });

  it.each([
    ["a status", "Секунду, сравниваю меню и отзывы."],
    ["a heading", "Сравнил оба места, вот что вышло:"],
  ])("delivers a comparison the person asked for after %s", (_case, first) => {
    const compared = [
      userMessage(
        "Где лучше поужинать вчетвером — в Пушкине или в Кофемании? Забронируй на 19:00"
      ),
      ...toolStep("web_search", { results: [] }),
      ...sendMessage("first", first),
    ];

    expect(
      refusal(
        compared,
        "В «Пушкине» тише и есть отдельный зал, в «Кофемании» шумно, зато кухня разнообразнее. Бронировать «Пушкин» на 19:00?"
      )
    ).toBeUndefined();
  });

  it("delivers the translation the person asked for as its own message", () => {
    const history = [
      userMessage("переведи «я опоздаю на 10 минут» на английский и немецкий"),
      ...sendMessage(
        "english",
        "По-английски: I'll be 10 minutes late, sorry."
      ),
    ];

    expect(
      refusal(
        history,
        "По-немецки: Ich komme 10 Minuten zu spät, tut mir leid."
      )
    ).toBeUndefined();
    // The same translation in another word order is no news.
    expect(
      refusal(history, "Sorry, I'll be late by 10 minutes — это по-английски.")
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

  it.each([
    "Записал тебя к терапевту на пт 10:00 — добавлю в календарь, как подтвердишь.",
    "Занял слот у стоматолога на 12:00 — сейчас добавлю событие в календарь.",
    "Scheduled your visit for Friday 10:00 — I'll add it to your calendar once you confirm.",
  ])(
    "delivers «%s»: the calendar step is only promised (review #30)",
    (text) => {
      // The report of a confirmed booking asks for exactly this message: the
      // booking the site made, and the calendar entry still to come.
      const report = [
        userMessage(`${backgroundTurnMarker}\n\nBrowser run run-1 finished.`),
      ];

      expect(refusal(report, text)).toBeUndefined();
      expect(
        refusal([userMessage("запиши меня к терапевту на пятницу")], text)
      ).toBeUndefined();
    }
  );

  it.each([
    "Записал тебя к терапевту, добавил в календарь и поставлю напоминание.",
    "Поставлю напоминание, а встречу уже добавил в календарь.",
  ])("still returns «%s», a write said as done", (text) => {
    expect(
      refusal([userMessage("запиши меня к терапевту на пятницу")], text)
    ).toEqual({ rewrite: "calendar" });
  });

  it("asks a report for the future tense while its calendar tool is held (review #25)", () => {
    const report = [
      userMessage(`${backgroundTurnMarker}\n\nBrowser run run-1 finished.`),
    ];
    const claim = "Записал тебя к терапевту на пт 10:00 и добавил в календарь.";

    // The calendar tool comes back only after this message, so «use it
    // first» cannot be followed.
    expect(refusal(report, claim)).toEqual({ rewrite: "calendar-later" });
    expect(rewriteSendNotice("calendar-later")).toContain("future tense");
    // Once a message is out, the tool is there again.
    const told = [...report, ...sendMessage("a", "Записал тебя к терапевту.")];
    expect(
      refusal(told, "Добавил событие в календарь: пятница 10:00, каб. 212.")
    ).toEqual({
      rewrite: "calendar",
    });
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
  value: Extract<ToolResultPart["output"], { type: "json" }>["value"],
  input: Readonly<Record<string, JSONValue>> = {}
): ModelMessage[] {
  toolSteps += 1;
  const toolCallId = `${toolName}-${String(toolSteps)}`;
  return [
    {
      content: [{ input, toolCallId, toolName, type: "tool-call" }],
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

/**
 * Tool steps whose calls the model made in one step: one assistant message
 * with every call, then one tool message with every result.
 */
function inOneStep(...steps: readonly ModelMessage[][]): ModelMessage[] {
  const stepMessages = steps.flat();
  const calls = stepMessages.flatMap((stepMessage) =>
    stepMessage.role === "assistant" && Array.isArray(stepMessage.content)
      ? stepMessage.content.filter((part) => part.type === "tool-call")
      : []
  );
  const results = stepMessages.flatMap((stepMessage) =>
    stepMessage.role === "tool"
      ? stepMessage.content.filter((part) => part.type === "tool-result")
      : []
  );
  return [
    { content: calls, role: "assistant" },
    { content: results, role: "tool" },
  ];
}

function browserStep(
  action: string,
  value: Extract<ToolResultPart["output"], { type: "json" }>["value"],
  input: Readonly<Record<string, JSONValue>> = {}
): ModelMessage[] {
  toolSteps += 1;
  const toolCallId = `browser_task-${String(toolSteps)}`;
  return [
    {
      content: [
        {
          input: { ...input, action },
          toolCallId,
          toolName: "browser_task",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: { type: "json", value },
          toolCallId,
          toolName: "browser_task",
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
