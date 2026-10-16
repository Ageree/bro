/**
 * The tool router's groups and its one request to the decision model
 * (docs/dev-notes.md, «Роутер инструментов»): a `noul` question per group,
 * each named after its group, and the thresholds measured for each model.
 *
 * The groups in the order their tools join the tool block, after the core.
 */
export const routerGroups = [
  "browser",
  "yandex",
  "places",
  "phone",
  "calendar",
  "files",
  "mail",
  "schedules",
  "settings",
  "media",
  "events",
  "docs",
  "chat_apps",
  "money",
] as const;

export type RouterGroup = (typeof routerGroups)[number];

/**
 * One `noul` question of System One: the probability of «yes». The kit
 * router asks its own (`agent/lib/kit-router/questions.ts`).
 */
export interface RouterQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: { readonly true: string; readonly false: string };
}

/**
 * The questions, word for word as measured on 15.10 (the evaluation's
 * `q/v4.json`: 459 cases, 82 of them the owner's real turns): a changed
 * word needs a new run of the evaluation and new thresholds. Each question
 * is named after its group, and the request sends them in this order, as
 * the evaluation did.
 */
export const routerQuestions = {
  browser: {
    type: "noul",
    instructions:
      "Нужно ли Бро открыть сторонний сайт в своём браузере и что-то там сделать или проверить, или продолжить, проверить или отменить такое поручение, которое уже идёт?",
    criteria: {
      true: "Покупка, бронь, запись, регистрация, публикация, заполнение формы или карточки, поиск товаров и билетов на сайтах (Ozon, Wildberries, Avito, Госуслуги, сайты клиник, отелей, авиакомпаний, каталоги стартапов), проверка штрафов или заказа на сайте, вход в аккаунт на сайте, список или забывание входов Бро на сайты; продолжение, уточнение или проверка хода такого поручения, в том числе короткий ответ («да», «ну что?», «давай», «стоп», «возьми мой ник», код из SMS) на сообщение Бро о нём.",
      false:
        "Сервисы Яндекса (такси, Еда, Лавка, Маркет, Карты, Афиша), почта, календарь, звонки, напоминания, картинки, файлы, болтовня, вопросы, на которые хватит поиска в интернете.",
    },
  },
  yandex: {
    type: "noul",
    instructions:
      "Касается ли сообщение сервисов Яндекса: такси Яндекс Go, Яндекс Еда, Лавка, Маркет, Яндекс Карты, Афиша?",
    criteria: {
      true: "Заказать или отменить такси, узнать цену поездки, заказать еду или продукты с доставкой, корзина, оплата или статус такого заказа, поиск на Маркете или в Картах; короткий ответ на сообщение Бро о таком заказе.",
      false:
        "Покупки на других сайтах, почта, календарь, звонки, всё остальное.",
    },
  },
  mail: {
    type: "noul",
    instructions:
      "Нужна ли для ответа электронная почта: прочитать, найти, переслать письмо, ответить на письмо, написать письмо, черновик, вложение или код из письма, подключить почту или Google?",
    criteria: {
      true: "Любое действие с письмами человека или ящиком Бро; «ответь/напиши такому-то» без указания другого канала; короткий ответ на сообщение Бро о письме.",
      false: "Slack, звонки, календарь без писем, всё остальное.",
    },
  },
  calendar: {
    type: "noul",
    instructions:
      "Нужен ли календарь человека: посмотреть планы, встречи, рейсы, визиты; проверить, свободен ли он; создать, перенести или удалить событие; подключить Google?",
    criteria: {
      true: "Вопросы «что у меня завтра», «свободен ли я», «во сколько у меня…», «когда ближайший рейс», просьбы поставить, перенести или удалить встречу или событие; короткий ответ на сообщение Бро о календаре.",
      false:
        "Напоминания и регулярные сводки без события в календаре, брони и покупки на сайтах, всё остальное.",
    },
  },
  docs: {
    type: "noul",
    instructions:
      "Нужны ли файлы человека в Google Диске (диск, драйв, гугл-док, гугл-таблица) или заметки и задачи в Notion?",
    criteria: {
      true: "Найти, открыть, прочитать или пересказать документ, файл или папку на Google Диске; добавить, прочитать или отметить задачу или заметку в Notion; подключить Notion.",
      false:
        "Файл, присланный в чат, создание новой презентации или таблицы, почта, всё остальное.",
    },
  },
  chat_apps: {
    type: "noul",
    instructions:
      "Нужен ли Slack: прочитать, найти или отправить сообщение в Slack, подключить Slack?",
  },
  phone: {
    type: "noul",
    instructions:
      "Нужен ли телефон: позвонить кому-то или в организацию, узнать итог звонка, найти, сохранить или удалить номер в записной книжке Бро, узнать цену, подключить или отключить номер Бро для звонков?",
    criteria: {
      true: "«Позвони», «набери», «звони», чей-то номер телефона; уточнение для звонка, который Бро делает или предлагает сделать (на чьё имя бронь, какое время подходит), или короткий ответ на сообщение Бро о звонке или номере.",
      false: "Письма, Slack, такси, всё остальное.",
    },
  },
  schedules: {
    type: "noul",
    instructions:
      "Нужно ли создать, изменить или удалить напоминание по времени, регулярную рассылку или сводку, или начать следить за ценой или рейсом?",
    criteria: {
      true: "«Напомни в … / через …», «каждый день/неделю присылай», перенести или удалить напоминание или сводку, следить за ценой, рейсом.",
      false:
        "Просто показать список напоминаний, напоминание при приходе в место или уходе из него, события календаря, всё остальное.",
    },
  },
  money: {
    type: "noul",
    instructions:
      "Говорит ли человек о лимите трат без спроса или о постоянном разрешении Бро платить или действовать без его подтверждения?",
    criteria: {
      true: "Лимит трат без спроса, разрешение всегда покупать или действовать без подтверждения, отмена такого разрешения, сколько потрачено без спроса.",
      false:
        "Разовое согласие на конкретную оплату («да, оплачивай»), сохранение карты, всё остальное.",
    },
  },
  media: {
    type: "noul",
    instructions:
      "Нужно ли нарисовать или сгенерировать картинку или видео, оживить фото, или найти фотографии в интернете?",
  },
  files: {
    type: "noul",
    instructions:
      "Нужно ли сделать или обработать файл: презентацию, слайды, документ, таблицу, PDF, резюме, код или скрипт, график, конвертацию, расчёт по присланному файлу, или собрать материалы для карточки продукта?",
    criteria: {
      true: "Создание или переделка слайдов, документов, таблиц, PDF, кода; разбор присланного файла; отмена или правка такой задачи.",
      false:
        "Картинка или видео по описанию, файлы на Google Диске, просто текст ответом в чате.",
    },
  },
  events: {
    type: "noul",
    instructions:
      "Ищет ли человек мероприятия: концерты, лекции, мастер-классы, выставки, стендапы, митапы, куда сходить?",
  },
  places: {
    type: "noul",
    instructions:
      "Нужно ли знать, где человек находится сейчас или где был раньше?",
    criteria: {
      true: "«Рядом», «поблизости», «тут», «отсюда», «сюда», «где я», где припарковался, сколько идти или ехать, как доехать, маршрут — даже если город назван; напоминание при приходе в место или уходе из него (домой, на работу, в аэропорт, к магазину); прошлые места и поездки; присланная геолокация.",
      false:
        "Город или адрес назван явно и местоположение человека не нужно; всё остальное.",
    },
  },
  settings: {
    type: "noul",
    instructions:
      "Меняет ли человек настройки Бро: писать ли ему первым, обращение на ты или вы, как его звать, привязка Telegram, сохранить карту или адрес в сейф?",
    criteria: {
      true: "Просьбы писать или не писать первым, перейти на ты или вы, звать по имени, привязать Telegram, сохранить карту, адрес или контакт в сейф.",
      false:
        "Лимиты и разрешения на траты, удаление из памяти, отмена заказов и задач, всё остальное.",
    },
  },
} as const satisfies Readonly<Record<RouterGroup, RouterQuestion>>;

/**
 * The threshold of each group by the model the answer names: a group is
 * offered when its probability is at least this. Read only by the model of
 * the answer, never by the one asked for: another model there is a failure
 * (`decision.ts`), and a new model comes in only with a new key here from a
 * run of the evaluation.
 *
 * - `jev-1.14.0` (TypeSafe directly): recall of the groups 0.998 on 459
 *   cases, 1.000 on the owner's real turns, 1.37 groups a turn.
 * - `typesafe/jev-1.13-20260917` (RouterAI): tuned on the same cases on
 *   15.10 for recall 0.99, then each capped at 0.5, since a tuning on the
 *   cases it is judged on is optimistic.
 */
export const routerThresholds = {
  "jev-1.14.0": {
    browser: 0.3,
    calendar: 0.5,
    chat_apps: 0.5,
    docs: 0.3,
    events: 0.5,
    files: 0.4,
    mail: 0.5,
    media: 0.5,
    money: 0.5,
    phone: 0.4,
    places: 0.4,
    schedules: 0.5,
    settings: 0.5,
    yandex: 0.4,
  },
  "typesafe/jev-1.13-20260917": {
    browser: 0.15,
    calendar: 0.5,
    chat_apps: 0.5,
    docs: 0.15,
    events: 0.5,
    files: 0.5,
    mail: 0.4,
    media: 0.5,
    money: 0.5,
    phone: 0.5,
    places: 0.4,
    schedules: 0.5,
    settings: 0.5,
    yandex: 0.5,
  },
} as const satisfies Readonly<
  Record<string, Readonly<Record<RouterGroup, number>>>
>;

/**
 * How much of each text the decision model reads, in characters: the
 * previous message of Bro's from its start, and a long message of the
 * person's as its head and its tail («ответь на это» after a long paste).
 */
export const routerStateLimits = {
  head: 700,
  prev: 600,
  tail: 700,
  text: 1500,
} as const;

/** What each group holds, as `open_tools` lists them. */
export const routerGroupIndex = {
  browser: "сайты: файлы для сайта, входы, заказы",
  calendar: "календарь: проверить, создать, перенести, удалить событие",
  chat_apps: "Slack",
  docs: "Google Диск и Notion",
  events: "мероприятия Timepad",
  files: "файлы и код: помощник с компьютером",
  mail: "почта: Gmail, Mail.ru, Яндекс, ящик Бро, контакты",
  media: "картинки и видео: нарисовать, оживить, найти фото",
  money: "лимит трат и постоянные разрешения",
  phone: "звонки и записная книжка",
  places: "где человек, маршруты, напоминания у места",
  schedules: "создать напоминание или сводку, следить за ценой или посылкой",
  settings: "обращение, привязка Telegram, сейф",
  yandex: "Яндекс: такси, Еда, Лавка, Маркет, Карты",
} as const satisfies Readonly<Record<RouterGroup, string>>;
