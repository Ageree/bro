import { broToBroModelId } from "@agent/lib/bro-to-bro/model";
import { browserUseConfigured } from "@agent/lib/browser-use/client";
import { customProxy } from "@agent/lib/browser-use/proxy";
import { browserVmConfigured } from "@agent/lib/browser-vm/backend";
import { memoryDigestModelId } from "@agent/lib/memory/digest/classifier";
import { supermemoryConfigured } from "@agent/lib/memory/supermemory";
import { taskFilesDeployed } from "@agent/lib/sandbox/pilot";
import { instantSearchEnabled } from "@agent/lib/web-search/instant";
import { yooKassaConfigured } from "@db/services/yookassa";
import { composioConfigured } from "@shared/composio/api";
import { env } from "@shared/environment";
import { artifactStorageConfigured } from "@shared/object-storage/artifacts";
import { directModelProviderName } from "@shared/model/provider";
import { photonConfigured } from "@shared/photon/credentials";
import { yoomoneyConfigured } from "@shared/yoomoney/api";

/**
 * What Bro keeps about the person and where, as this deployment is built:
 * the app and the agent run on a Selectel VM in Russia (`docs/dev-notes.md`,
 * «Прод на VM»), the records live in Selectel's managed Postgres, files in
 * Bro's private bucket in Selectel Object Storage. On 25.09 (RU d14) Bro said
 * only «в облаке сервиса» and «Postgres в облаке».
 */
export function keptData(
  options: {
    /** Bro ↔ Bro is on for the workspace (`broToBroStanding`). */
    readonly broToBro?: boolean;
    /** The workspace is in the cross-channel pilot (`conversation_log`). */
    readonly conversationLog?: boolean;
    /** The workspace is in the geolocation pilot (`location_points`). */
    readonly location?: boolean;
    /** Bro follows a live share by itself (`locationWatchPilot`). */
    readonly locationWatch?: boolean;
    readonly phone?: boolean;
    /** Signing with the person's signature is on (`signEnabled`). */
    readonly signature?: boolean;
    /** Bro keeps what it did across chats (`workLogEnabled`). */
    readonly workLog?: boolean;
  } = {}
) {
  return [
    ...(options.phone
      ? [
          "Телефония: привязка выделенного номера к владельцу, идентификаторы провайдеров, состояния звонков и известные расходы — в Postgres. Бро не сохраняет аудио или полную расшифровку; краткий итог и номер собеседника очищаются после доставки отчёта, когда с запуска прошло 30 дней. Привязка номера и история состояний остаются для защиты от повторного звонка и учёта платного ресурса.",
        ]
      : []),
    `Память (факты, предпочтения, правила), сохранённые дела, личные данные (имя, телефон, почта, адрес), расписания, сейф, заказы и итоги поручений${yooKassaConfigured() ? ", история оплат подписки" : ""}${browserUseConfigured() ? ", сайты, где облачный браузер держит вход, со ссылкой на страницу аккаунта на каждом" : ""} — в управляемой базе Postgres Selectel (Россия).`,
    "Пароли и карты из сейфа лежат там же в зашифрованном виде (AES-256-GCM): языковая модель их не видит.",
    ...(options.signature === true
      ? [
          "Образец подписи (картинка с фото или имя для рукописного шрифта), если человек попросил его сохранить, — в той же базе Postgres в зашифрованном виде (AES-256-GCM). Его просмотр («Подпись (образец)») и подписанные документы — обычные файлы, как другие, что присылает Бро: в Object Storage Selectel, по ссылке. Для каждого подписания Бро хранит название и хэш документа, места, свой вопрос и ответ человека — чтобы было видно, на что дано согласие.",
        ]
      : []),
    // Without the bucket nothing is stored (`artifactStorageConfigured`).
    ...(artifactStorageConfigured()
      ? [
          "Файлы — вложения писем, файлы с Диска, нарисованные картинки и снимки страниц из поручений — в приватном хранилище Object Storage Selectel (Россия).",
        ]
      : []),
    ...(taskFilesDeployed()
      ? [
          "Файлы, которые Бро передаёт помощнику с компьютером, копируются в его песочницу на сервере Selectel (Россия) и в приватное хранилище Object Storage Selectel.",
        ]
      : []),
    "Приложение и сам Бро работают на виртуальной машине Selectel в России; история переписки (сессии Бро) хранится в той же базе Postgres.",
    ...(env.OWNER_TRANSCRIPTS === "on"
      ? [
          `Владелец сервиса может читать тексты переписки с Бро, чтобы находить и чинить ошибки: они хранятся ${String(env.OWNER_TRANSCRIPTS_RETENTION_DAYS)} дн. и затем удаляются, коды и пароли из них вырезаются. Метаданные ходов (время, длительность, ошибки) хранятся и без текстов.`,
        ]
      : []),
    ...(options.location === true
      ? [
          "Геопозицию, которой вы сами поделились (точка, место или трансляция в Telegram, карточка геопозиции в iMessage, кнопка в веб-чате), Бро хранит до 90 дней в базе Postgres Selectel (Россия), чтобы отвечать «где я припарковался» и напоминать у мест. «Забудь, где я был» удаляет эти точки сразу; то, что уже было в переписке (адрес в ответах Бро, сама присланная точка), остаётся в истории чатов, пока живёт сессия, и до 14 дней — в ночных зашифрованных резервных копиях.",
          ...(options.locationWatch === true
            ? [
                "Пока вы транслируете геопозицию в Telegram, Бро сам замечает, где вы остановились и откуда ушли, сверяет это с вашим календарём и тем, что помнит, и пишет первым, только если это что-то меняет (например, вы опаздываете на встречу), — не ночью и никому другому. Остановите трансляцию — перестанет.",
              ]
            : []),
        ]
      : []),
    ...(options.broToBro === true
      ? [
          "Бро ↔ Бро: связи с Бро других людей и что вы каждому открыли (время по календарю, «что можно рассказывать»), переговоры и журнал того, что ваш Бро и Бро собеседника сказали друг другу, — в той же базе Postgres; журнал хранится 180 дней. Поручения, ваши ответы Бро в переговорах, его вопросы вам, задержанные черновики и тема переговоров стираются через 30 дней после того, как переговоры закончились; «что можно рассказывать» и ваша подпись к связи — через 30 дней после того, как связь разорвана, подпись к приглашению — через 30 дней после того, как его приняли или оно истекло. Когда оба подтвердили встречу, Бро сам ставит её в ваш Google Календарь, если Google подключён с полным доступом: название, время, место и строка «Договорились Бро ↔ Бро с …» — без поручения и переписки; id этого события остаётся в базе.",
        ]
      : []),
    ...(options.conversationLog === true
      ? [
          "Сообщения человека в веб-чате, Telegram и iMessage (каждое до 500 знаков) 14 дней хранятся и в той же базе Postgres, чтобы в одном чате Бро знал, о чём человек писал в другом; «удали всё, что ты про меня помнишь» стирает их сразу; что уже попало в сводку другого чата, остаётся в истории того чата, как вся переписка. Стёртые и истёкшие строки ещё до 14 дней остаются в ночных зашифрованных резервных копиях базы.",
        ]
      : []),
    ...(options.workLog === true
      ? [
          "Что Бро сделал в чатах — ваши просьбы в веб-чате, Telegram и iMessage с названиями присланных файлов и ответы Бро там (каждая строка до 2000 знаков, без одноразовых кодов, номеров карт и паролей) — 30 дней хранится в той же базе Postgres, чтобы в новом чате, и голосом тоже, Бро помнил, что уже разобрал, посчитал или написал; сами файлы и ссылки туда не попадают. Любая ваша просьба что-то забыть стирает эти строки сразу, «забудь, где я был» — строки того же времени; стёртые и истёкшие строки ещё до 14 дней остаются в ночных зашифрованных резервных копиях базы.",
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
    broToBro = false,
    decisionModel = false,
    location = false,
    partnerLinks = false,
    phone = false,
    voice,
    yclients = false,
  }: {
    readonly memoryDigest?: boolean;
    readonly agentMail?: boolean;
    /** Bro ↔ Bro is on for the workspace (`broToBroStanding`). */
    readonly broToBro?: boolean;
    /**
     * The workspace's messages reach a decision model: the tool router's
     * pilot, the kit router's, or the model router's with routes
     * (`agent/tools/privacy.ts`).
     */
    readonly decisionModel?: boolean;
    readonly location?: boolean;
    /** Links to travel brands go out as partner links (`partnerLinksPilot`). */
    readonly partnerLinks?: boolean;
    readonly phone?: boolean;
    /**
     * GPT-Live carries the workspace's voice: /talk (`voiceTalkEnabled`), its
     * calls (`liveCallsFor`) or both; `brief` when /talk's voice gets the
     * person's brief (`voiceFastEnabled`).
     */
    readonly voice?: {
      readonly brief: boolean;
      readonly calls: boolean;
      readonly talk: boolean;
    };
    /** The workspace books salons through YClients (`yclientsPilot`). */
    readonly yclients?: boolean;
  } = {}
) {
  const direct = directModelProviderName();
  return [
    ...(phone
      ? [
          "Звонки обслуживают МТС Exolve и ElevenLabs: оператор видит телефонные номера и может записывать разговор, а ElevenLabs получает только задачу конкретного исходящего звонка и минимальный нужный контекст, обрабатывает голос и формирует итог. Всю память Бро туда не отправляет; входящий звонящий не получает доступ к данным владельца. Записи и расшифровки могут храниться у провайдеров по их правилам, их удаление из Бро не удаляет данные у провайдера.",
        ]
      : []),
    ...(voice === undefined
      ? []
      : [
          `${voice.talk ? (voice.calls ? "Голосовой разговор с Бро и звонки" : "Голосовой разговор с Бро") : "Звонки Бро"} ведёт голосовая модель GPT-Live компании OpenAI: она слышит разговор и говорит голосом Бро.${voice.talk && voice.brief ? " В разговоре с самим человеком она получает и сводку о нём: имя, записи памяти (кроме закрытых записей, кодов и паролей), напоминания, дела Бро в других чатах, итоги последних звонков и события календаря на неделю вперёд." : ""}${voice.calls ? " Собеседнику звонка голос называет только задачу звонка и то, что Бро разрешил сказать после проверки." : ""}`,
        ]),
    direct !== undefined
      ? `Сообщения и всё, что Бро читает для ответа (письма, события, страницы, память), обрабатывает языковая модель ${modelId}: запрос идёт через ${direct} к провайдеру, который эту модель запускает${direct === "RouterAI" && modelId.startsWith("deepseek/") ? " (для моделей DeepSeek — хост DeepInfra)" : ""}. Голосовые сообщения распознаёт и картинки рисует тоже модель через ${direct}, а запросы веб-поиска ${instantSearchEnabled() ? `идут через Composio к поисковикам TinyFish и Tavily, а если те не ответили — через ${direct} к поисковикам Exa и Perplexity` : `${direct} передаёт поисковикам Exa и Perplexity`}.`
      : `Сообщения и всё, что Бро читает для ответа (письма, события, страницы, память), обрабатывает языковая модель ${modelId}: запрос идёт через Vercel AI Gateway к её провайдеру.`,
    ...(direct === "RouterAI" && env.RUNINFRA_API_KEY !== undefined
      ? [
          "Модель DeepSeek V4.1 Flash для ответов Бро запускает RunInfra: такие запросы идут туда напрямую, а через RouterAI — только если RunInfra не ответил.",
        ]
      : []),
    ...(decisionModel
      ? [
          "Чтобы выбрать нужные инструменты, правила или модель для задания, короткий текст сообщения (без кодов, номеров документов и длинных чисел) и прошлого ответа Бро получает модель Jev компании TypeSafe — напрямую или через RouterAI; она возвращает только вероятности и ничего не делает.",
        ]
      : []),
    ...(env.BROWSER_USE_API_KEY === undefined
      ? []
      : [
          "Поручения на сайтах Бро выполняет сам, в облачном браузере сервиса Browser Use: сервис видит страницы и данные, нужные поручению, получает пароль или карту из сейфа только на время запуска и только для сайта поручения и хранит куки сайтов, куда входил, в профиле браузера.",
        ]),
    ...(customProxy() !== undefined && env.BROWSER_USE_API_KEY !== undefined
      ? [
          "Облачный браузер ходит на сайты через прокси-сервер деплоя: прокси видит, на какие сайты он заходит.",
        ]
      : []),
    ...(artifactStorageConfigured()
      ? [
          "Файлы (вложения писем, файлы с Диска, нарисованные картинки, снимки страниц) хранит Selectel в приватном хранилище Object Storage (Россия): открыть их можно только через Бро.",
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
    ...(direct !== undefined && broToBro
      ? [
          `Переговоры с Бро других людей (Бро ↔ Бро) ведёт отдельный вызов модели ${broToBroModelId()} через ${direct}: он получает ваше имя и часовой пояс, свободные варианты времени из календаря (без названий событий), поручение этих переговоров, ваши ответы на его вопросы и «что можно рассказывать». Проверка перед отправкой — второй вызов той же модели — видит только сообщение, цель, варианты времени и «что можно рассказывать». Память, почту и чаты с Бро ни один из них не видит; Бро собеседника получает только сообщения, прошедшие проверку.`,
        ]
      : []),
    ...(env.MAIL_WORKSPACES === undefined
      ? []
      : [
          "Личную почту Mail.ru или Яндекса (если вы её подключили) Бро читает по IMAP: письма, нужные для вашей просьбы, видит языковая модель.",
        ]),
    ...(env.YOOMONEY_WORKSPACES === undefined || !yoomoneyConfigured()
      ? []
      : [
          "Кошелёк ЮMoney (если вы его подключили) Бро читает и платит с него через API ЮMoney: номер кошелька, баланс, операции и данные платежа, нужные для вашей просьбы (получатель, лицевой счёт, телефон), видит языковая модель; каждый платёж — только после вашего «да» на вопрос с точной суммой. Ключ доступа к кошельку хранится в базе Бро зашифрованным.",
        ]),
    ...(env.YANDEX_API_WORKSPACES === undefined
      ? []
      : [
          "С сервисами Яндекса (Еда, Лавка, Go, Маркет) Бро работает через свой браузер от вашего аккаунта: Яндекс видит заказы и поездки, которые вы поручили.",
          ...(location
            ? [
                "При геолокации поиск мест на Яндекс Картах (через ваш аккаунт Яндекса) получает координаты вашей последней присланной точки за 2 часа, если вы не назвали другое место.",
              ]
            : []),
        ]),
    ...(env.SANDBOX_WORKSPACES === undefined
      ? []
      : [
          "Код и работу с файлами Бро выполняет в изолированной песочнице на сервере Selectel (Россия).",
        ]),
    location
      ? "Адреса для расчёта дороги уходят в открытые сервисы OpenStreetMap, а при геолокации — и координаты присланных точек, чтобы узнать адрес; без имени и контактов."
      : "Адреса для расчёта дороги уходят в открытые сервисы OpenStreetMap.",
    ...(env.TIMEPAD_API_KEY === undefined
      ? []
      : [
          "Поиск мероприятий идёт через Timepad: ему уходят город, слова поиска и даты, без имени и контактов.",
        ]),
    ...(env.TINYFISH_API_KEY === undefined && env.EXA_API_KEY === undefined
      ? []
      : [
          "Веб-поиск идёт через TinyFish и Exa: им уходит только текст поискового запроса.",
        ]),
    ...(env.VOICE_QUICK_WORKSPACES === undefined
      ? []
      : [
          "Прогноз погоды в голосовом разговоре берётся у MET Norway: ему уходят координаты города, без имени и контактов; курс валют — у ЦБ РФ.",
        ]),
    ...(yclients
      ? [
          "Запись в салоны, студии и клиники, которые принимают её через YClients, Бро делает через API YClients: свободное время он смотрит без ваших данных, а при записи салон получает ваши имя, телефон и почту — как с формы записи на его сайте.",
        ]
      : []),
    ...(partnerLinks
      ? [
          "Ссылки на страницы Островка, Яндекс Путешествий и Авиасейлс Бро отправляет партнёрскими: адрес страницы уходит в Travelpayouts, без имени и контактов, а бронирование по такой ссылке приносит владельцу Бро комиссию и ничего не стоит вам.",
        ]
      : []),
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
  const fallbackHost = env.BROWSER_VM_PROXY_FALLBACK?.host;
  const proxyService =
    fallbackHost === undefined
      ? proxyServiceAt(proxyHost)
      : `${proxyServiceAt(proxyHost)} или ${proxyServiceAt(fallbackHost)}`;
  return [
    `Поручения на сайтах Бро выполняет сам, в своём браузере на ${browserVmPlace()}, у каждого человека своей: он видит страницы и данные, нужные поручению, и получает пароль или карту из сейфа только на время запуска и только для сайта поручения. На диске машины, даже выключенной, хранятся профиль браузера с куки сайтов, куда он входил, тексты и итоги поручений и снимки страниц.`,
    `Браузером на этой машине управляет языковая модель ${env.BROWSER_VM_MODEL} через ${modelService}: модель видит текст поручения и страницы, которые открывает браузер.`,
    `Браузер на этой машине ходит на сайты через резидентный прокси ${proxyService}: прокси видит, на какие сайты он заходит.`,
    ...(env.BROWSER_VM_TWOCAPTCHA_API_KEY === undefined
      ? []
      : [
          "Если сайт закрывается головоломкой-капчей, которую браузер не собрал сам, её решает сервис 2Captcha: он видит адрес страницы и саму капчу, но не данные человека.",
        ]),
  ];
}

/** A residential proxy by the provider its host names, or by the host. */
function proxyServiceAt(host: string) {
  if (/geonode/iu.test(host)) return "Geonode";
  if (/nodemaven/iu.test(host)) return "NodeMaven";
  return `сервис ${host}`;
}

/**
 * Where the browser VMs run: the pool's own Selectel servers
 * (`BROWSER_HOST_CLOUD=static`), or a Cloud.ru zone, whose `ru.*` names are
 * Cloud.ru's Russian data centres.
 */
function browserVmPlace() {
  if (env.BROWSER_HOST_CLOUD === "static") {
    return "виртуальной машине на выделенном сервере Selectel в России";
  }
  const zone = env.CLOUDRU_ZONE;
  return `виртуальной машине в облаке Cloud.ru (${zone.startsWith("ru.") ? `зона ${zone}, Россия` : `зона ${zone}`})`;
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
    // «Войти через Telegram» (`telegramLogin`): the bot sends the code.
    ...(env.TELEGRAM_BOT_TOKEN === undefined
      ? []
      : [
          "Код для входа через Telegram присылает бот Бро в Telegram: Telegram видит код, номер телефона ему не нужен.",
        ]),
  ];
}

/**
 * The app, the database, the files and the browser VMs stand in Russia, on
 * Selectel's servers. The other services (the model's hosts, Composio,
 * ElevenLabs and the rest) publish no region in Bro's settings, so Bro must
 * not guess one for them — a person asks because of 152-ФЗ.
 */
export function serverLocation() {
  return "Приложение, база данных и файлы Бро стоят на серверах Selectel в России. В каких странах стоят серверы остальных сервисов (языковая модель и её хосты, Composio, звонки, почта и другие), Бро не знает: регион нигде в его настройках не записан. Утверждать, что их данные хранятся в России (или что за её пределами), он не может.";
}
