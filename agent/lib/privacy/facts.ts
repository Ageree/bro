import { browserUseConfigured } from "@agent/lib/browser-use/client";
import { customProxy } from "@agent/lib/browser-use/proxy";
import { browserVmConfigured } from "@agent/lib/browser-vm/backend";
import { memoryDigestModelId } from "@agent/lib/memory/digest/classifier";
import { supermemoryConfigured } from "@agent/lib/memory/supermemory";
import { taskFilesDeployed } from "@agent/lib/sandbox/pilot";
import { yooKassaConfigured } from "@db/services/yookassa";
import { composioConfigured } from "@shared/composio/api";
import { env } from "@shared/environment";
import { artifactStorageConfigured } from "@shared/object-storage/artifacts";
import { directModelProviderName } from "@shared/model/provider";
import { photonConfigured } from "@shared/photon/credentials";

/**
 * What Bro keeps about the person and where, as this deployment is built:
 * the app and the agent run on Vercel, the records live in Postgres on Neon,
 * files in Bro's private bucket in Object Storage on Cloud.ru. On 25.09 (RU d14) Bro said only «в
 * облаке сервиса» and «Postgres в облаке».
 */
export function keptData(
  options: {
    /** The workspace is in the cross-channel pilot (`conversation_log`). */
    readonly conversationLog?: boolean;
    readonly phone?: boolean;
  } = {}
) {
  return [
    ...(options.phone
      ? [
          "Телефония: привязка выделенного номера к владельцу, идентификаторы провайдеров, состояния звонков и известные расходы — в Postgres. Бро не сохраняет аудио или полную расшифровку; краткий итог и номер собеседника очищаются после доставки отчёта, когда с запуска прошло 30 дней. Привязка номера и история состояний остаются для защиты от повторного звонка и учёта платного ресурса.",
        ]
      : []),
    `Память (факты, предпочтения, правила), сохранённые дела, личные данные (имя, телефон, почта, адрес), расписания, сейф, заказы и итоги поручений${yooKassaConfigured() ? ", история оплат подписки" : ""}${browserUseConfigured() ? ", сайты, где облачный браузер держит вход, со ссылкой на страницу аккаунта на каждом" : ""} — в базе Postgres в Neon.`,
    "Пароли и карты из сейфа лежат там же в зашифрованном виде (AES-256-GCM): языковая модель их не видит.",
    // Without the bucket nothing is stored (`artifactStorageConfigured`).
    ...(artifactStorageConfigured()
      ? [
          "Файлы — вложения писем, файлы с Диска, нарисованные картинки и снимки страниц из поручений — в приватном хранилище Object Storage облака Cloud.ru.",
        ]
      : []),
    ...(taskFilesDeployed()
      ? [
          "Файлы, которые Бро передаёт помощнику с компьютером, копируются в его песочницу на Cloud.ru и в приватное хранилище Object Storage Cloud.ru.",
        ]
      : []),
    "Приложение и сам Бро работают на Vercel; история переписки (сессии Бро) хранится там же, в Vercel Workflow.",
    ...(options.conversationLog === true
      ? [
          "Сообщения человека в веб-чате, Telegram и iMessage (каждое до 500 знаков) 14 дней хранятся и в той же базе Postgres, чтобы в одном чате Бро знал, о чём человек писал в другом; «удали всё, что ты про меня помнишь» стирает их сразу; что уже попало в сводку другого чата, остаётся в истории того чата, как вся переписка. Стёртые и истёкшие строки ещё до 14 дней остаются в ночных зашифрованных резервных копиях базы.",
        ]
      : []),
  ];
}

/**
 * Which outside services see the person's data, and what of it: every one
 * this deployment is configured with, and only those, with the model the
 * workspace runs on. The result tells the model to add none of its own, so a
 * configured service missing here is a service the person never hears of.
 * The judges of RU d14 (25.09) missed the language model's provider and the
 * cloud browser, which Bro never named.
 */
export function dataProcessors(
  modelId: string,
  {
    memoryDigest = false,
    agentMail = false,
    phone = false,
  }: {
    readonly memoryDigest?: boolean;
    readonly agentMail?: boolean;
    readonly phone?: boolean;
  } = {}
) {
  const direct = directModelProviderName();
  return [
    ...(phone
      ? [
          "Звонки обслуживают МТС Exolve и ElevenLabs: оператор видит телефонные номера и может записывать разговор, а ElevenLabs получает только задачу конкретного исходящего звонка и минимальный нужный контекст, обрабатывает голос и формирует итог. Всю память Бро туда не отправляет; входящий звонящий не получает доступ к данным владельца. Записи и расшифровки могут храниться у провайдеров по их правилам, их удаление из Бро не удаляет данные у провайдера.",
        ]
      : []),
    direct !== undefined
      ? `Сообщения и всё, что Бро читает для ответа (письма, события, страницы, память), обрабатывает языковая модель ${modelId}: запрос идёт через ${direct} к провайдеру, который эту модель запускает. Голосовые сообщения распознаёт и картинки рисует тоже модель через ${direct}, а запросы веб-поиска ${direct} передаёт поисковикам Exa и Perplexity.`
      : `Сообщения и всё, что Бро читает для ответа (письма, события, страницы, память), обрабатывает языковая модель ${modelId}: запрос идёт через Vercel AI Gateway к её провайдеру.`,
    ...(env.BROWSER_USE_API_KEY === undefined
      ? []
      : [
          "Поручения на сайтах выполняет облачный браузер Browser Use: он видит страницы и данные, нужные поручению, получает пароль или карту из сейфа только на время запуска и только для сайта поручения и хранит куки сайтов, куда входил, в профиле браузера.",
        ]),
    ...(customProxy() !== undefined && env.BROWSER_USE_API_KEY !== undefined
      ? [
          "Облачный браузер ходит на сайты через прокси-сервер деплоя: прокси видит, на какие сайты он заходит.",
        ]
      : []),
    ...(artifactStorageConfigured()
      ? [
          "Файлы (вложения писем, файлы с Диска, нарисованные картинки, снимки страниц) хранит Cloud.ru в приватном хранилище Object Storage: открыть их можно только через Бро.",
        ]
      : []),
    ...browserVms(),
    ...(browserUseConfigured() ? keepAliveVisits() : []),
    ...(composioConfigured()
      ? [
          "Доступ к Google, Notion, Slack и другим подключённым приложениям держит Composio: там хранятся ключи от этих аккаунтов, и через него идут запросы к ним.",
        ]
      : []),
    ...(agentMail
      ? [
          "Собственную почту Бро обслуживает AgentMail: сервис хранит адрес ящика агента, входящие и отправленные письма и видит их адресатов и содержимое. Личный Gmail человека — отдельное подключение. В базе Бро хранятся привязка ящика и идентификаторы отправок для защиты от повторной отправки.",
        ]
      : []),
    ...(supermemoryConfigured()
      ? [
          "Записи памяти, кроме помеченных как только локальные, могут индексироваться в Supermemory для поиска по смыслу; забытое оттуда тоже удаляется.",
        ]
      : []),
    ...(direct !== undefined && memoryDigest
      ? [
          `Раз в сутки сводка памяти отправляет тексты записей памяти (кроме правил, предпочтений и записей, помеченных как только локальные) модели ${memoryDigestModelId()} через ${direct}, чтобы найти разовые, повторяющиеся и устаревшие записи; модель отвечает только номерами записей.`,
        ]
      : []),
    "Адреса для расчёта дороги уходят в открытые сервисы OpenStreetMap.",
    ...(yooKassaConfigured()
      ? [
          "Оплату подписки принимает ЮKassa: карту человек вводит на её странице, а Бро передаёт ей только сумму и номер кабинета; данные карты Бро не видит и не хранит.",
        ]
      : []),
    ...messengers(),
  ];
}

/**
 * The browser VMs: where each stands, what its disk keeps between errands,
 * and the two services every errand on one goes through — the model that
 * drives its browser and the residential proxy that is its only way out.
 * Each is named by the address this deployment set for it.
 */
function browserVms() {
  const proxyHost = env.BROWSER_VM_PROXY?.host;
  if (!browserVmConfigured() || proxyHost === undefined) return [];
  const modelHost = URL.parse(env.BROWSER_VM_LLM_BASE_URL)?.hostname ?? "";
  const modelService = /(?:^|\.)routerai\.ru$/iu.test(modelHost)
    ? "RouterAI"
    : `сервис ${modelHost}`;
  const proxyService = /geonode/iu.test(proxyHost)
    ? "Geonode"
    : `сервис ${proxyHost}`;
  return [
    `Поручения на сайтах выполняет браузер Бро на виртуальной машине в облаке Cloud.ru (${browserVmZone()}), у каждого человека своей: он видит страницы и данные, нужные поручению, и получает пароль или карту из сейфа только на время запуска и только для сайта поручения. На диске машины, даже выключенной, хранятся профиль браузера с куки сайтов, куда он входил, тексты и итоги поручений и снимки страниц.`,
    `Браузером на этой машине управляет языковая модель ${env.BROWSER_VM_MODEL} через ${modelService}: модель видит текст поручения и страницы, которые открывает браузер.`,
    `Браузер на этой машине ходит на сайты через резидентный прокси ${proxyService}: прокси видит, на какие сайты он заходит.`,
    ...(env.BROWSER_VM_TWOCAPTCHA_API_KEY === undefined
      ? []
      : [
          "Если сайт закрывается головоломкой-капчей, которую браузер не собрал сам, её решает сервис 2Captcha: он видит адрес страницы и саму капчу, но не данные человека.",
        ]),
  ];
}

/**
 * The one place the settings do name: the Cloud.ru zone the browser VMs are
 * created in. Zones named `ru.*` are Cloud.ru's Russian data centres.
 */
function browserVmZone() {
  const zone = env.CLOUDRU_ZONE;
  return zone.startsWith("ru.") ? `зона ${zone}, Россия` : `зона ${zone}`;
}

/**
 * The visits Bro makes on its own, with no errand and no message: the
 * person hears of them here or not at all.
 */
function keepAliveVisits() {
  const days = env.BROWSER_USE_SIGN_IN_REFRESH_DAYS;
  if (days === 0) return [];
  return [
    `Чтобы вход не пропадал, раз в ${String(days)} дн. облачный браузер сам, без поручения, открывает страницу аккаунта на сайтах, где за последний месяц было поручение и он вошёл (кроме Госуслуг и сайтов, куда человек просил не заходить), ничего там не нажимает и закрывает её.`,
  ];
}

function messengers() {
  const names = [
    ...(env.TELEGRAM_BOT_TOKEN === undefined ? [] : ["Telegram"]),
    ...(photonConfigured() ? ["iMessage (через сервис Photon)"] : []),
  ];
  return [
    ...(names.length === 0
      ? []
      : [
          `Переписка в ${names.join(" и ")} проходит и через ${names.length > 1 ? "эти мессенджеры" : "этот мессенджер"}.`,
        ]),
    // The sign-in code goes out as an iMessage through Photon
    // (`sendPhoneCode`), whichever chat the person uses afterwards.
    ...(photonConfigured()
      ? [
          "Код для входа по номеру телефона приходит через Photon: сервис видит номер и код.",
        ]
      : []),
  ];
}

/**
 * Neither the deployment's settings nor its code name a region for any of
 * these services, so Bro cannot say where the servers stand — and must not
 * guess «в России» for a person who asks because of 152-ФЗ. The browser VMs
 * are the one exception: the Cloud.ru zone they are created in is a setting.
 */
export function serverLocation() {
  if (!browserVmConfigured()) {
    return "В каких странах стоят серверы этих сервисов, Бро не знает: регион нигде в его настройках не записан. Утверждать, что данные хранятся в России (или что за её пределами), он не может.";
  }
  return `Виртуальные машины браузера стоят в облаке Cloud.ru (${browserVmZone()}): зона записана в настройках Бро. В каких странах стоят серверы остальных сервисов, Бро не знает: регион нигде в его настройках не записан. Утверждать, что остальные данные хранятся в России (или что за её пределами), он не может.`;
}
