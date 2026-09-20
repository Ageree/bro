/**
 * Group 6 — the same Bro, two doors.
 *
 * One conversation reaches the person through iMessage or through Telegram, and
 * the two channels disagree about almost everything a message is made of: bold
 * text, buttons, link previews, message length, even whether a reaction counts
 * as a reply. The compiler pair (`telegram-text` / `imessage-text`) is the only
 * place that knows, so the stories below feed ONE model answer into both and
 * assert that each door gets something it can actually render.
 *
 * The second half of the group is the part that bites in production and is
 * invisible from this repository: a Telegram deployment that is half-configured
 * answers «недоступен» to a person who can see the bot in their contacts.
 * `telegramHealth` turns those facts into one verdict, and it is walked here.
 */

import type { Journey } from "./runner.ts";
import {
  compileTelegram,
  splitTelegramHtml,
  stripButtonBlocksForIMessage,
  TELEGRAM_TEXT_LIMIT,
  toTelegramHtml,
} from "../../../agent/lib/telegram-text.ts";
import { toIMessageBubbles, toIMessageText } from "../../../agent/lib/imessage-text.ts";
import {
  bindRefuseText,
  bindTelegramDecision,
  canDeliverTelegram,
  lastChannelOf,
  parseTelegramStart,
  telegramBindLink,
  telegramHealth,
  telegramWebhookUrl,
  telegramWelcomeText,
  TELEGRAM_BIND_TTL_MS,
  TELEGRAM_START_PREFIX,
} from "../../../convex/lib/telegramPolicy.ts";
import { routingFromAuth } from "../../../agent/lib/turn-routing.ts";
import { isTelegramAsk, welcomeBubbles } from "../../../agent/lib/onboard-policy.ts";
import { isBluePhotonService, refuseSmsText } from "../../../convex/lib/photonPolicy.ts";
import { turnVoice, voiceInstruction } from "../../../agent/lib/turn-voice.ts";
import { repoText } from "./runner.ts";

const INSTRUCTIONS = repoText("agent/instructions.md");

/** One answer the model produced. Both channels have to render it. */
const ANSWER = [
  "**Готово**, заказал.",
  "",
  ":::buttons",
  "[Открыть заказ](https://www.wildberries.ru/lk/orders)",
  ":::",
].join("\n");

const HEALTHY = {
  origin: "https://bro.example",
  hasToken: true,
  configuredUsername: "brobot",
  hasWebhookSecret: true,
  botUsername: "brobot",
  webhookUrl: "https://bro.example/webhooks/telegram",
};

const TOKEN = "a".repeat(32);

export const CHANNELS: Journey[] = [
  {
    name: "Один ответ модели — два канала, два разных текста",
    group: "channels",
    steps: [
      {
        it: "в Telegram жирный становится тегом",
        got: () => toTelegramHtml("**Готово**, заказал."),
        contains: "<b>Готово</b>",
      },
      {
        it: "в iMessage тега нет — там разметки не существует",
        got: () => toIMessageText("**Готово**, заказал."),
        lacks: "<b>",
      },
      {
        it: "и звёздочки в iMessage тоже не остаются",
        got: () => toIMessageText("**Готово**, заказал."),
        lacks: "**",
      },
      {
        it: "кнопка в Telegram становится настоящей кнопкой",
        got: () => compileTelegram(ANSWER).buttons[0]?.[0]?.url,
        want: "https://www.wildberries.ru/lk/orders",
      },
      {
        it: "а в iMessage — подписью и ссылкой отдельной строкой",
        got: () => toIMessageText(ANSWER),
        contains: "https://www.wildberries.ru/lk/orders",
      },
      {
        it: "разметка блока кнопок в iMessage не протекает",
        got: () => stripButtonBlocksForIMessage(ANSWER),
        lacks: ":::buttons",
      },
      {
        it: "в html-версии кнопка в текст не попадает — она уехала в клавиатуру",
        got: () => compileTelegram(ANSWER).html,
        lacks: "Открыть заказ",
      },
      {
        it: "оба канала в итоге несут одно и то же дело",
        got: () => [
          toIMessageText(ANSWER).includes("Готово"),
          compileTelegram(ANSWER).html.includes("Готово"),
        ],
        want: [true, true],
      },
    ],
  },

  {
    name: "«Телеграм доступен?» — Bro выдаёт ссылку, а не отвечает «недоступен»",
    group: "channels",
    steps: [
      {
        it: "вопрос словами распознаётся",
        got: () => isTelegramAsk("телеграм есть?"),
        want: true,
      },
      {
        it: "и без вопросительного знака тоже",
        got: () => isTelegramAsk("телеграм"),
        want: true,
      },
      {
        it: "инструкция называет ложью не только «недоступен»",
        got: () => INSTRUCTIONS,
        contains: "«Телегу не подрубили»",
      },
      {
        it: "и «пока только тут» — ту самую фразу с телефона владельца",
        got: () => INSTRUCTIONS,
        contains: "«пока только тут»",
      },
      {
        it: "ссылка на бота строится с токеном привязки",
        got: () => telegramBindLink("brobot", TOKEN),
        contains: `${TELEGRAM_START_PREFIX}${TOKEN}`,
      },
      {
        it: "бот читает этот /start обратно",
        got: () => parseTelegramStart(`/start ${TELEGRAM_START_PREFIX}${TOKEN}`),
        want: { command: true, token: TOKEN },
      },
      {
        it: "токен живёт полчаса, а не вечно",
        got: () => TELEGRAM_BIND_TTL_MS,
        want: 30 * 60 * 1000,
      },
      {
        it: "привязка проходит — это тот же человек",
        got: () =>
          bindTelegramDecision({
            now: 1_000,
            tokenFound: true,
            tenantPhone: "+79990000001",
            incomingUserId: "tg-1",
          }),
        want: "ok",
      },
      {
        it: "в Telegram человека встречает тот же Bro, а не новый бот",
        got: () => telegramWelcomeText(),
        contains: "Тот же Bro",
      },
    ],
  },

  {
    name: "Зелёный пузырь: Bro отвечает только в iMessage",
    group: "channels",
    steps: [
      {
        it: "iMessage — синий канал, его принимаем",
        got: () => isBluePhotonService({ service: "iMessage" }),
        want: true,
      },
      {
        it: "SMS — нет",
        got: () => isBluePhotonService({ service: "SMS" }),
        want: false,
      },
      {
        it: "RCS — тоже нет",
        got: () => isBluePhotonService({ service: "RCS" }),
        want: false,
      },
      {
        it: "человеку объясняют, что именно выключить, а не просто отказывают",
        got: () => refuseSmsText(),
        contains: "Отправлять как SMS",
      },
      {
        it: "и куда нажать",
        got: () => refuseSmsText(),
        contains: "Настройки",
      },
    ],
  },

  {
    name: "Реакция вместо текста — законный ответ на «спасибо»",
    group: "channels",
    steps: [
      {
        it: "«спасибо» без ожидающего джоба — короткий ход",
        got: () =>
          turnVoice({
            origin: "human",
            shortAck: true,
            waitingForHuman: false,
            jobCheck: false,
            dueNudges: 0,
            browserPollForceSpeak: false,
          }),
        want: "ack_only",
      },
      {
        it: "инструкция этого хода разрешает тапбек вместо текста",
        got: () => voiceInstruction("ack_only"),
        contains: "tapback",
      },
      {
        it: "и разрешает молчание после него",
        got: () => voiceInstruction("ack_only"),
        contains: "[SILENT]",
      },
      {
        it: "реакции при этом остаются доступными тулами",
        got: () => voiceInstruction("ack_only"),
        contains: "imessage_react / telegram_react",
      },
      {
        it: "а тяжёлые тулы — нет",
        got: () => voiceInstruction("ack_only"),
        contains: "Do not call browser_task",
      },
      {
        it: "и общий голос продукта прямо разрешает промолчать",
        got: () => INSTRUCTIONS,
        contains: "поставь реакцию",
      },
    ],
  },

  {
    name: "Telegram привязан к другому человеку — привязка отказывает по-разному",
    group: "channels",
    steps: [
      {
        it: "чужой Telegram у этого Bro",
        got: () =>
          bindTelegramDecision({
            now: 1_000,
            tokenFound: true,
            tenantPhone: "+79990000001",
            tenantTelegramUserId: "tg-1",
            incomingUserId: "tg-2",
          }),
        want: "already_other_user",
      },
      {
        it: "и человеку это объясняют словами",
        got: () => bindRefuseText("already_other_user"),
        contains: "другому Telegram",
      },
      {
        it: "этот Telegram уже у другого Bro — другая ошибка",
        got: () =>
          bindTelegramDecision({
            now: 1_000,
            tokenFound: true,
            tenantPhone: "+79990000001",
            otherTenantPhone: "+79990000002",
            incomingUserId: "tg-1",
          }),
        want: "already_other_tenant",
      },
      {
        it: "и другой текст",
        got: () => bindRefuseText("already_other_tenant"),
        contains: "другому Bro",
      },
      {
        it: "неизвестный токен отправляют за ссылкой в iMessage",
        got: () => bindRefuseText("unknown_token"),
        contains: "напиши там «телеграм»",
      },
      {
        it: "телефон ещё не привязан — сначала iMessage",
        got: () =>
          bindTelegramDecision({ now: 1_000, tokenFound: true, incomingUserId: "tg-1" }),
        want: "unbound_phone",
      },
    ],
  },

  {
    name: "Ссылка на привязку протухла — не молча, а с новой ссылкой",
    group: "channels",
    steps: [
      {
        it: "просроченный токен отказывает",
        got: () =>
          bindTelegramDecision({
            now: 10_000,
            tokenFound: true,
            expiresAt: 5_000,
            tenantPhone: "+79990000001",
            incomingUserId: "tg-1",
          }),
        want: "expired",
      },
      {
        it: "и человеку говорят, как получить новую",
        got: () => bindRefuseText("expired"),
        contains: "пришлю новую",
      },
      {
        it: "ровно на границе TTL токен уже мёртв",
        got: () =>
          bindTelegramDecision({
            now: 5_000,
            tokenFound: true,
            expiresAt: 5_000,
            tenantPhone: "+79990000001",
            incomingUserId: "tg-1",
          }),
        want: "expired",
      },
      {
        it: "просто «/start» без токена — не привязка, а знакомство",
        got: () => parseTelegramStart("/start"),
        want: { command: true, token: null },
      },
      {
        it: "обычное сообщение командой не становится",
        got: () => parseTelegramStart("привет"),
        want: null,
      },
    ],
  },

  {
    name: "Telegram настроен наполовину — и это честно называется",
    group: "channels",
    steps: [
      {
        it: "полностью настроенный канал здоров",
        got: () => telegramHealth(HEALTHY).ok,
        want: true,
      },
      {
        it: "без токена и имени Telegram просто выключен — это не поломка",
        got: () =>
          telegramHealth({
            origin: HEALTHY.origin,
            hasToken: false,
            configuredUsername: "",
            hasWebhookSecret: false,
          }).off,
        want: true,
      },
      {
        it: "без имени бота ссылку выдать нечем — и это названо",
        got: () => telegramHealth({ ...HEALTHY, configuredUsername: "" }).problems.join("\n"),
        contains: "TELEGRAM_BOT_USERNAME",
      },
      {
        it: "имя бота не совпало с токеном — каждая ссылка ведёт не туда",
        got: () => telegramHealth({ ...HEALTHY, botUsername: "otherbot" }).problems.join("\n"),
        contains: "wrong bot",
      },
      {
        it: "без секрета вебхука бот глохнет на 401",
        got: () => telegramHealth({ ...HEALTHY, hasWebhookSecret: false }).problems.join("\n"),
        contains: "401",
      },
      {
        it: "но с ноутбука оператора отсутствие секрета ничего не доказывает",
        got: () =>
          telegramHealth({ ...HEALTHY, hasWebhookSecret: false, webhookSecretVisible: false }).ok,
        want: true,
      },
    ],
  },

  {
    name: "Вебхук Telegram смотрит на прошлый деплой",
    group: "channels",
    steps: [
      {
        it: "правильный адрес выводится из origin деплоя",
        got: () => telegramWebhookUrl("https://bro.example"),
        want: "https://bro.example/webhooks/telegram",
      },
      {
        it: "лишний слэш в origin не ломает адрес",
        got: () => telegramWebhookUrl("https://bro.example/"),
        want: "https://bro.example/webhooks/telegram",
      },
      {
        it: "вебхук на чужом хосте — дрейф",
        got: () => telegramHealth({ ...HEALTHY, webhookUrl: "https://old.example/webhooks/telegram" }).webhookDrifted,
        want: true,
      },
      {
        it: "и человеку-оператору сказано, куда именно его вернуть",
        got: () =>
          telegramHealth({ ...HEALTHY, webhookUrl: "https://old.example/webhooks/telegram" }).problems.join("\n"),
        contains: "https://bro.example/webhooks/telegram",
      },
      {
        it: "вебхука нет вовсе — тот же дрейф, другой текст",
        got: () => telegramHealth({ ...HEALTHY, webhookUrl: "" }).problems.join("\n"),
        contains: "no webhook set",
      },
      {
        it: "очередь недоставленных апдейтов тоже видна",
        got: () => telegramHealth({ ...HEALTHY, pendingUpdates: 42 }).problems.join("\n"),
        contains: "42 updates",
      },
    ],
  },

  {
    name: "Ход пришёл из Telegram, а чата для ответа нет",
    group: "channels",
    steps: [
      {
        it: "канал хода — телеграм",
        got: () => routingFromAuth({ origin: "human", channel: "telegram", telegramChatId: "123" }).channel,
        want: "telegram",
      },
      {
        it: "с чатом доставить можно",
        got: () => routingFromAuth({ origin: "human", channel: "telegram", telegramChatId: "123" }).canDeliver,
        want: true,
      },
      {
        it: "без чата — некуда",
        got: () => routingFromAuth({ origin: "human", channel: "telegram" }).canDeliver,
        want: false,
      },
      {
        it: "пустой chatId каналом доставки не считается",
        got: () => canDeliverTelegram(""),
        want: false,
      },
      {
        it: "iMessage-ход по умолчанию доставляем",
        got: () => routingFromAuth({ origin: "human" }).canDeliver,
        want: true,
      },
      {
        it: "последний канал человека читается из строки, а мусор — это iMessage",
        got: () => [lastChannelOf("telegram"), lastChannelOf("что-то"), lastChannelOf(null)],
        want: ["telegram", "imessage", "imessage"],
      },
    ],
  },

  {
    name: "Длинный ответ: Telegram режет по абзацам, iMessage — по пузырям",
    group: "channels",
    steps: [
      {
        it: "лимит одного сообщения Telegram — 4096",
        got: () => TELEGRAM_TEXT_LIMIT,
        want: 4096,
      },
      {
        it: "короткий ответ не режется",
        got: () => splitTelegramHtml("коротко").length,
        want: 1,
      },
      {
        it: "длинный — режется на несколько кусков",
        got: () => splitTelegramHtml(`${"абзац. ".repeat(900)}`).length > 1,
        want: true,
      },
      {
        it: "и каждый кусок влезает в лимит",
        got: () => splitTelegramHtml(`${"абзац. ".repeat(900)}`).every((c) => c.length <= TELEGRAM_TEXT_LIMIT),
        want: true,
      },
      {
        it: "нумерованный список в iMessage становится несколькими пузырями",
        got: () =>
          toIMessageBubbles(
            [
              "1. Кроссовки Nike Air Max 270, 8990 рублей, размер 42, доставка в ПВЗ на Ленина послезавтра",
              "2. Кроссовки Adidas Ultraboost 22, 11990 рублей, размер 42, доставка в ПВЗ на Ленина завтра",
              "3. Кроссовки Puma RS-X, 6490 рублей, размер 42, доставка в ПВЗ на Ленина сегодня вечером",
            ].join("\n"),
          ).length,
        want: 3,
      },
      {
        it: "а короткий ответ остаётся одним пузырём",
        got: () => toIMessageBubbles("готово, заказал").length,
        want: 1,
      },
    ],
  },

  {
    name: "Голос продукта одинаков в обоих каналах",
    group: "channels",
    steps: [
      {
        it: "приветственные пузыри существуют как константа продукта",
        got: () => welcomeBubbles().length > 0,
        want: true,
      },
      {
        it: "инструкция называет Telegram живым вторым каналом",
        got: () => INSTRUCTIONS,
        contains: "второй канал",
      },
      {
        it: "и требует говорить на языке человека",
        got: () => INSTRUCTIONS,
        contains: "Speak the user's language",
      },
      {
        it: "робо-фразы перечислены прямо и запрещены",
        got: () => INSTRUCTIONS,
        contains: "«Статус:»",
      },
      {
        it: "в Telegram HTML экранируется, иначе «<» сломает сообщение",
        got: () => toTelegramHtml("цена < 5000"),
        contains: "&lt;",
      },
      {
        it: "в iMessage экранировать нечего — там обычный текст",
        got: () => toIMessageText("цена < 5000"),
        contains: "< 5000",
      },
    ],
  },
];
