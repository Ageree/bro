/**
 * Group 1 — apps the person already owns, reached through Composio.
 *
 * The story shape here is always the same: ask to connect, hand over a
 * Connect Link, wait for the person to come back, check the connection, read
 * something, act on it. The two failure stories matter as much as the happy
 * one: a link that never reached the human, and an app that is simply not
 * connected. Both are places where Bro is capable of reporting a success that
 * did not happen, which is the single most expensive kind of lie for an agent
 * that spends money and books tables.
 *
 * `sendConnectIfAny` itself lives in `agent/tools/composio.ts` and imports
 * `eve/tools`, so it cannot be called offline. Its contract is asserted where
 * it is written instead: the branch texts in the tool and the rule in the
 * skill that reads them.
 */

import { type Journey, repoText } from "./runner.ts";
import {
  isConnectDest,
  publicOrigin,
  stripConnectUrls,
  wrapConnectUrl,
} from "../../../agent/lib/connect-link.ts";
import {
  deliveryBackoffMs,
  EVENT_TTL_MS,
  eventPayload,
  eventPrompt,
  formatEvent,
  hmacSha256Base64,
  ownsEvent,
  parseComposioEvent,
  shouldRetryDelivery,
  signatureMatches,
  timestampFresh,
  triggerSpec,
  verifyComposioWebhook,
  describeWatcher,
  isWatchSource,
} from "../../../convex/lib/watcherPolicy.ts";
import { routingFromAuth } from "../../../agent/lib/turn-routing.ts";
import { canDeliverTelegram } from "../../../convex/lib/telegramPolicy.ts";
import { turnVoice } from "../../../agent/lib/turn-voice.ts";

const COMPOSIO_TOOL = repoText("agent/tools/composio.ts");
const COMPOSIO_SKILL = repoText("agent/skills/composio/SKILL.md");

/** The failure texts `sendConnectIfAny` hands back to the model. */
function undeliveredReasons(): string[] {
  const start = COMPOSIO_TOOL.indexOf("async function sendConnectIfAny");
  const end = COMPOSIO_TOOL.indexOf("async function runComposio");
  const body = COMPOSIO_TOOL.slice(start, end);
  return [...body.matchAll(/return\s+"([^"]+)"/g)].map((m) => m[1]!);
}

const LIVE_LINK = "https://connect.composio.dev/c/9f2a1b";

const GMAIL_EVENT = JSON.stringify({
  type: "composio.trigger.message",
  id: "evt_1",
  metadata: {
    trigger_id: "trg_1",
    trigger_slug: "gmail_new_gmail_message",
    user_id: "+79990000001",
    connected_account_id: "ca_1",
  },
  data: {
    sender: "clinic@invitro.ru",
    subject: "Результаты анализов готовы",
    message_text: "Заберите результаты до пятницы.",
    message_id: "m_1",
    thread_id: "t_1",
  },
});

const CALENDAR_EVENT = JSON.stringify({
  trigger_name: "googlecalendar_google_calendar_event_sync_trigger",
  trigger_id: "trg_2",
  log_id: "log_2",
  connection_id: "ca_2",
  payload: {
    event_type: "updated",
    summary: "Созвон с юристом",
    start_time: "2026-09-17T15:00:00+03:00",
    location: "Zoom",
    attendees: [{ email: "lawyer@firm.ru" }],
  },
});

export const APPS: Journey[] = [
  {
    name: "«Подключи почту» — ссылка ушла, человек вернулся, письмо прочитано",
    group: "apps",
    steps: [
      {
        it: "человек пишет «подключи почту» — это обычное поручение, не короткое «ок»",
        got: () =>
          turnVoice({
            origin: "human",
            shortAck: false,
            waitingForHuman: false,
            jobCheck: false,
            dueNudges: 0,
            browserPollForceSpeak: false,
          }),
        want: "free",
      },
      {
        it: "Composio минтит Connect Link — Bro признаёт его ссылкой на подключение",
        got: () => isConnectDest(LIVE_LINK),
        want: true,
      },
      {
        it: "ссылка уходит только через собственный /l, а не сырым URL",
        got: () => wrapConnectUrl(LIVE_LINK).startsWith(`${publicOrigin()}/l?to=`),
        want: true,
      },
      {
        it: "сырой composio-URL из текста модели вырезается — он предъявитель доступа",
        got: () => stripConnectUrls(`Вот ссылка ${LIVE_LINK} открой её`),
        lacks: "composio.dev",
      },
      {
        it: "но собственную обёртку /l санитайзер не трогает, иначе карточка исчезнет",
        got: () => stripConnectUrls(`открой ${wrapConnectUrl(LIVE_LINK)}`),
        contains: "/l?to=",
      },
      {
        it: "человек подтвердил доступ, gmail-пуш прилетает вебхуком",
        got: () => parseComposioEvent(GMAIL_EVENT)?.triggerSlug,
        want: "GMAIL_NEW_GMAIL_MESSAGE",
      },
      {
        it: "письмо приходит в ход как помеченные данные, а не как текст человека",
        got: () =>
          formatEvent("GMAIL_NEW_GMAIL_MESSAGE", parseComposioEvent(GMAIL_EVENT)!.data),
        contains: "[event:gmail]",
      },
      {
        it: "в тексте события видна тема письма — есть по чему действовать",
        got: () =>
          formatEvent("GMAIL_NEW_GMAIL_MESSAGE", parseComposioEvent(GMAIL_EVENT)!.data),
        contains: "Результаты анализов готовы",
      },
      {
        it: "фоновый ход по событию прямо разрешает молчание, если это не по делу",
        got: () => eventPrompt(eventPayload("почта клиники", "тема")),
        contains: "[SILENT]",
      },
    ],
  },

  {
    name: "Ссылка не ушла — Bro обязан сказать правду, а не отчитаться об успехе",
    group: "apps",
    steps: [
      {
        it: "у тула есть отдельное поле для «человек ссылку не получил»",
        got: () => COMPOSIO_TOOL.includes("ссылка_не_ушла: undelivered"),
        want: true,
      },
      {
        it: "перечислены все срывы доставки карточки, а не один общий catch",
        got: () => undeliveredReasons().length,
        satisfies: (n) => typeof n === "number" && n >= 5,
        wanted: "не меньше пяти разных причин «ссылка не ушла»",
      },
      {
        it: "каждая причина написана как провал, а не как успех",
        // `\b` is ASCII-only in JS regex, so `\bне\b` matches nothing in
        // Cyrillic — the boundaries have to be spelled with lookarounds.
        got: () =>
          undeliveredReasons().filter((r) => !/(?<!\p{L})не(?!\p{L})/u.test(r)),
        want: [],
      },
      {
        it: "ход без conversationId — слать карточку буквально некуда",
        got: () => undeliveredReasons().some((r) => r.includes("conversationId")),
        want: true,
      },
      {
        it: "скилл велит сказать об этом первой строкой и не выдавать за успех",
        got: () => COMPOSIO_SKILL,
        contains: "не выдавай за успех",
      },
      {
        it: "Composio при этом честно отвечает «connection initiated» — успех тула ≠ успех человека",
        got: () => COMPOSIO_TOOL.includes("Composio's own result says the connection was initiated"),
        want: true,
      },
    ],
  },

  {
    name: "Composio вернул ссылку на дашборд — это не хендофф, карточки не будет",
    group: "apps",
    steps: [
      {
        it: "страница дашборда без /link/ не считается ссылкой на подключение",
        got: () => isConnectDest("https://dashboard.composio.dev/apps/gmail"),
        want: false,
      },
      {
        it: "а настоящий /link/ на том же хосте — считается",
        got: () => isConnectDest("https://dashboard.composio.dev/link/abc123"),
        want: true,
      },
      {
        it: "раз признанных ссылок нет — у тула есть ровно эта причина",
        got: () => undeliveredReasons().some((r) => r.includes("не признал ссылкой")),
        want: true,
      },
      {
        it: "и человек всё равно услышит «не вышло», а не «подключил»",
        got: () => undeliveredReasons().find((r) => r.includes("не признал ссылкой")),
        contains: "не выдавай это за успех",
      },
    ],
  },

  {
    name: "Подключение просят из Telegram, а чат для ответа не записан",
    group: "apps",
    steps: [
      {
        it: "ход помечен телеграмом, но chatId в атрибутах нет",
        got: () => routingFromAuth({ origin: "human", channel: "telegram" }).channel,
        want: "telegram",
      },
      {
        it: "в такой ход доставить нечего — canDeliver выключен",
        got: () => routingFromAuth({ origin: "human", channel: "telegram" }).canDeliver,
        want: false,
      },
      {
        it: "тот же вывод со стороны тенанта: пустой chatId — не канал доставки",
        got: () => canDeliverTelegram(null),
        want: false,
      },
      {
        it: "тул на этот случай отвечает «карточку отправить не смог»",
        got: () => undeliveredReasons().some((r) => r.includes("чат для ответа не записан")),
        want: true,
      },
    ],
  },

  {
    name: "Приложение не подключено — пользоваться им нельзя, и это говорится вслух",
    group: "apps",
    steps: [
      {
        it: "скилл формулирует правило прямо",
        got: () => COMPOSIO_SKILL,
        contains: "Нет подключения — значит этим приложением пользоваться нельзя",
      },
      {
        it: "и запрещает изображать попытку",
        got: () => COMPOSIO_SKILL,
        contains: "не изображай попытку",
      },
      {
        it: "сторож на неподключённом приложении не активен — события не его",
        got: () =>
          ownsEvent({ tenantPhone: "+79990000001", status: "paused" }, { userId: "+79990000001" }),
        want: false,
      },
      {
        it: "истёкший токен — это переподключение, а не ошибка на ровном месте",
        got: () => COMPOSIO_SKILL,
        contains: "истёкший токен — это переподключение",
      },
    ],
  },

  {
    name: "«Следи за письмами из клиники» — сторож с фильтром",
    group: "apps",
    steps: [
      {
        it: "gmail — допустимый источник слежки",
        got: () => isWatchSource("gmail"),
        want: true,
      },
      {
        it: "фильтр человека уезжает в конфиг триггера как gmail-запрос",
        got: () => triggerSpec("gmail", "from:invitro.ru").config.query,
        want: "from:invitro.ru",
      },
      {
        it: "без фильтра сторож слушает весь INBOX, а не пустой запрос",
        got: () => triggerSpec("gmail").config.labelIds,
        want: "INBOX",
      },
      {
        it: "сторож описывается человеку вместе с фильтром",
        got: () =>
          describeWatcher({ _id: "w1", source: "gmail", about: "письма из клиники", filter: "from:invitro.ru" }),
        contains: "фильтр: from:invitro.ru",
      },
      {
        it: "пришло событие чужого пользователя — это не мой сторож",
        got: () =>
          ownsEvent({ tenantPhone: "+79990000001", status: "active" }, { userId: "+79990000002" }),
        want: false,
      },
      {
        it: "а своё событие активный сторож принимает",
        got: () =>
          ownsEvent({ tenantPhone: "+79990000001", status: "active" }, { userId: "+79990000001" }),
        want: true,
      },
    ],
  },

  {
    name: "Календарь подключён — событие приходит пушем и читается как событие",
    group: "apps",
    steps: [
      {
        it: "у календаря свой слаг триггера",
        got: () => triggerSpec("calendar").slug,
        want: "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER",
      },
      {
        it: "удалённые события тоже слушаем — отмена встречи это новость",
        got: () => triggerSpec("calendar").config.showDeleted,
        want: true,
      },
      {
        it: "старый формат вебхука (trigger_name) всё ещё разбирается",
        got: () => parseComposioEvent(CALENDAR_EVENT)?.triggerSlug,
        want: "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER",
      },
      {
        it: "событие форматируется с началом встречи",
        got: () =>
          formatEvent(
            "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER",
            parseComposioEvent(CALENDAR_EVENT)!.data,
          ),
        contains: "начало: 2026-09-17T15:00:00+03:00",
      },
      {
        it: "и участник виден — есть с кем связать встречу",
        got: () =>
          formatEvent(
            "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_SYNC_TRIGGER",
            parseComposioEvent(CALENDAR_EVENT)!.data,
          ),
        contains: "lawyer@firm.ru",
      },
    ],
  },

  {
    name: "Чужой вебхук в наш обработчик — подпись и свежесть решают",
    group: "apps",
    steps: [
      {
        it: "свежая метка времени проходит",
        got: () => timestampFresh(String(Math.floor(1_700_000_000)), 1_700_000_000_000),
        want: true,
      },
      {
        it: "метка часовой давности — уже нет",
        got: () => timestampFresh(String(1_700_000_000), 1_700_000_000_000 + 3_600_000),
        want: false,
      },
      {
        it: "подпись не того формата не совпадает ни с чем",
        got: () => signatureMatches("v0,deadbeef", "deadbeef"),
        want: false,
      },
      {
        it: "правильно подписанный вебхук принимается",
        got: async () => {
          const body = GMAIL_EVENT;
          const ts = String(Math.floor(1_700_000_000));
          const sig = await hmacSha256Base64("s3cret", `evt_1.${ts}.${body}`);
          return verifyComposioWebhook({
            id: "evt_1",
            timestamp: ts,
            signature: `v1,${sig}`,
            body,
            secret: "s3cret",
            nowMs: 1_700_000_000_000,
          });
        },
        want: true,
      },
      {
        it: "тот же вебхук с чужим секретом — нет",
        got: async () => {
          const body = GMAIL_EVENT;
          const ts = String(Math.floor(1_700_000_000));
          const sig = await hmacSha256Base64("other", `evt_1.${ts}.${body}`);
          return verifyComposioWebhook({
            id: "evt_1",
            timestamp: ts,
            signature: `v1,${sig}`,
            body,
            secret: "s3cret",
            nowMs: 1_700_000_000_000,
          });
        },
        want: false,
      },
    ],
  },

  {
    name: "Мусор вместо события: битый JSON и проектные уведомления не будят Bro",
    group: "apps",
    steps: [
      {
        it: "битый JSON не парсится и не роняет обработчик",
        got: () => parseComposioEvent("{не json"),
        want: null,
      },
      {
        it: "служебное composio.* уведомление — не триггер",
        got: () => parseComposioEvent(JSON.stringify({ type: "composio.project.updated", data: {} })),
        want: null,
      },
      {
        it: "событие без trigger_id тоже не событие",
        got: () =>
          parseComposioEvent(
            JSON.stringify({ type: "composio.trigger.message", id: "e", metadata: {}, data: {} }),
          ),
        want: null,
      },
      {
        it: "незнакомый слаг всё же доносится до модели как сырые данные",
        got: () => formatEvent("SLACK_NEW_MESSAGE", { text: "привет" }),
        contains: "[event:slack_new_message]",
      },
    ],
  },

  {
    name: "Доставка события в ход сорвалась — три попытки и стоп",
    group: "apps",
    steps: [
      { it: "первая неудача — повторяем", got: () => shouldRetryDelivery(0), want: true },
      { it: "пауза перед первым повтором — полминуты", got: () => deliveryBackoffMs(0), want: 30_000 },
      { it: "перед вторым — вдвое больше", got: () => deliveryBackoffMs(1), want: 60_000 },
      { it: "после третьей — сдаёмся, а не долбим вечно", got: () => shouldRetryDelivery(2), want: false },
      {
        it: "и событие в любом случае живёт не дольше суток",
        got: () => EVENT_TTL_MS,
        want: 24 * 60 * 60_000,
      },
    ],
  },
];
