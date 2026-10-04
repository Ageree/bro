import type { ModelMessage } from "ai";
import { z } from "zod";
import {
  isGosuslugi,
  signsInWithGosuslugi,
} from "@agent/lib/browser-use/public-services";
import { appsNamedByPerson } from "@agent/lib/connected-apps/mentions";
import { type SkillName, skillNames } from "./catalog";

/**
 * Which skills a turn needs, from what the turn says and what the
 * conversation already did (docs/roadmap.md, item 24). A pure function of
 * its input — no database, no clock — so the memory slot's recall replays
 * identically (`agent/memory/bro_skills.ts`). It leans to attaching: a body the
 * turn did not need costs its tokens once and is read from the cache after,
 * a missing one costs the errand. Every benchmark message attaches what it
 * needs of browser, gov-services, meter-readings and money
 * (`tests/triggers.test.ts`).
 *
 * What it reads:
 * - the words of the turn's own messages: the person's text and
 *   `[голосовое]` transcripts, or a browser report the page wrote (it only
 *   picks among Bro's own rules, never a tool or an approval); media
 *   markers are not words, and photos sent with no word are meter readings;
 * - the files of the turn: a document, or its marker, is for the task agent;
 * - links in those words, public services' sites among them, and the
 *   `site` of every `browser_task` of the conversation;
 * - the domain tools the conversation already called, Bro's own question
 *   before paying or for readings, and what a browser run reported, so a
 *   skill stays for the turns that follow;
 * - whether the turn is a browser run's report, and the `first-contact`
 *   marker the channel adds to a workspace's very first message.
 *
 * Patterns spell a letter `\p{L}`: JavaScript's word class and word
 * boundary know only ASCII letters, even with the `u` flag.
 */

/**
 * A pattern of word starts: each alternative begins a word (no letter,
 * digit or `_` before it). An alternative ends a word with `(?!\p{L})`.
 */
function stems(...alternatives: readonly string[]) {
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}_])(?:${alternatives.join("|")})`,
    "iu"
  );
}

/** What the words of a turn say it is about, by skill. */
const wordSignals: Partial<Record<SkillName, RegExp>> = {
  browser: stems(
    String.raw`куп(и|ит|л)|покуп|закаж|заказ|дозаказ|заброн|брон|резерв`,
    String.raw`запиши|записать|запишись|оформ|оплат|возьми|сдвинь|поменяй`,
    String.raw`обменя|верни|вернуть|возврат|отпиши|отписа|продай|продать`,
    String.raw`выставь|откликн|подай|подать|пробей|зарегистрируй|регистрац`,
    String.raw`отключи|продли|сдай|логин|парол|войди|билет|рейс|перел[её]т`,
    String.raw`авиа|самол[её]т|поезд|сапсан|ласточк|электричк`,
    String.raw`(ж/?д|ржд)(?!\p{L})|купе|отел|гостиниц|хостел|апартамент`,
    String.raw`посуточн|аренд|такси|доставк|курьер|пункт\p{L}* выдачи|пвз`,
    String.raw`корзин|маркетплейс|посылк|трек|подписк|автоплат|вакан|резюме`,
    String.raw`осаго|каско|страховк|провайдер|тариф|шкаф|мебел|продукт`,
    String.raw`обед в офис|(по)?дешевле|успе\p{L}* (прийти|доехать|приехать)`,
    String.raw`в наличии|наличи|забрать сегодня|аптек|озон|ozon|wildberries`,
    String.raw`вб(?!\p{L})|wb(?!\p{L})|маркет(?!инг)|самокат|лавк|вкусвилл`,
    String.raw`перекр[её]ст|купер|сбермаркет|hoff|хофф|ikea|икеа|м\.?видео`,
    String.raw`днс(?!\p{L})|авито|avito|сдэк|cdek|почт\p{L}* росси|boxberry`,
    String.raw`аэрофлот|aeroflot|s7|победа|pobeda|туту|tutu|aviasales`,
    String.raw`авиасейл|островок|ostrovok|суточно|booking|airbnb`,
    String.raw`яндекс\s*(go|гоу|такси|еда|маркет)|профи|profi|hh(?!\p{L})`,
    String.raw`хэдхантер|headhunter|т-?банк|тинькоф|сбер|мой налог|инвитро`,
    String.raw`гемотест|телемост|buy|пополн|закинь|закинуть|привяж|привяз`,
    String.raw`пицц|суши|ролл(ы|ов)|еду\s+(домой|на дом)|на дом(?!\p{L})`,
    String.raw`переве(ди|сти|ду)\s+(\p{L}+\s+){0,2}\d|перевод\p{L}*\s+(на|по|\d)`,
    String.raw`(re-?)?order (me|the|two|a|an|some|lunch|food|it|this|that)`,
    String.raw`my order|place an order|book(?!s)|reserve|purchase`,
    String.raw`check(-|\s)?(me\s)?in|checkout|flights?|fares?|(?<!my )hotels?`,
    String.raw`tickets?|taxi|car(?!\p{L})|deliver|amazon|apply|register`,
    String.raw`refund|return|subscription|quotes?|switch us|redeliver`,
    String.raw`list those tickets|fax|insurance|tariffs?|apartments?`,
    String.raw`sign me up|login|password|sign in`
  ),
  "gov-services": stems(
    String.raw`госуслуг|gosuslug|esia|штраф|налог|вычет|пошлин|паспорт|загран`,
    String.raw`снилс|инн(?!\p{L})|омс(?!\p{L})|полис|врач|поликлиник|терапевт`,
    String.raw`педиатр|стоматолог|лор(?!\p{L})|анализ|емиас|emias|справк`,
    String.raw`несудимост|временн\p{L}* регистрац|стс|птс|водительск`,
    String.raw`ву(?!\p{L})|прав(а|ам|ах)(?!\p{L})|техосмотр|номер\p{L}* машин`,
    String.raw`регистрац\p{L}* (по месту|временн)|прописк|гибдд|мфц|фнс`,
    String.raw`мос\.?ру|mos\.ru|сфр|пенси|росреестр|дмс|виз(а|у|ы)(?!\p{L})`,
    String.raw`документ|fines?|tax(es)?(?!i)|visa|passport|licen[cs]e|gibdd`,
    String.raw`doctor|dentist|clinic|dms|bank statement`
  ),
  "meter-readings": stems(
    String.raw`показани|сч[её]тчик|электросч[её]тчик|квитанц|жку|жкх|коммунал`,
    String.raw`епд|еирц|мосэнергосбыт|за квартиру|электроэнерг|электричеств`,
    String.raw`meter|utility|electricity`
  ),
  recommendations: stems(
    String.raw`посовет|порекоменд|подбер|подобра|куда сходить|куда пойти`,
    // «Найди мне хороший крем» (04.10): the turn spent a step on
    // `load_skill recommendations` before its first search.
    String.raw`подыщи|(найди|найти|поищи|поискать)(\s+мне)?\s+(хорош|лучш|недорог|подходящ|какой|какую|какое|какие|что-нибудь|что-то)`,
    String.raw`где (поесть|поужинать|пообедать|позавтракать|выпить|посидеть)`,
    String.raw`поужин|пообед|ресторан|кафе|бар(?!\p{L})|стол(ик)?(?!\p{L})`,
    String.raw`мастер|сантехник|электрик|кружок|секци|концерт|выставк`,
    String.raw`спектакл|театр|балет|кино|что посмотреть|чем заняться|подар`,
    String.raw`рядом с|недалеко|пешком|не сетев|не сеть|вегетариан|отзыв`,
    String.raw`бан(ю|я|и)(?!\p{L})|квест|батут|ветклиник|клиник|аптек`,
    String.raw`препарат|придумай|recommend|suggest|where to|dinner(?! with)`,
    String.raw`lunch|restaurant|cafe|walking distance|near(?!ly)|not a chain`,
    String.raw`well-reviewed|reviews?|things to do|gift|concert|ballet|sights`
  ),
  google: stems(
    String.raw`почт(?!\p{L}* росси)|письм|gmail|входящ|ящик|рассылк|черновик`,
    String.raw`ответь|ответить|календар|встреч|событи|созвон|перенес|свобод`,
    String.raw`что у меня (на|в|сегодня|завтра)|диск(?!\p{L})|drive|гугл`,
    String.raw`google|таблиц|документ|pdf|контакт|приглашени|телемост`,
    String.raw`по чекам|чеки|разошли|участникам|что у тебя осталось`,
    String.raw`какой у тебя доступ|доступ к (почте|google|гугл)`,
    String.raw`(напиши|скинь|сообщи|передай|отправь|пригласи)\s+\p{L}+(е|ю|у)(?!\p{L})`,
    String.raw`e-?mails?|inbox|mail|repl(y|ies)`,
    String.raw`draft\p{L}* (a |the )?(repl|email|response|outreach)|calendar`,
    String.raw`meeting|invite|block|slots?|spreadsheet|sheet|contacts?`,
    String.raw`threads?|transcripts?`,
    // Putting something in the calendar or moving it, without the word.
    String.raw`(добавь|поставь|внеси)\s+(мне\s+)?на\s+(сегодня|завтра|послезавтра|понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье|\d)`,
    String.raw`agenda|reschedule|move my \d|push the (sync|call|meeting)`
  ),
  apps: stems(
    String.raw`notion|ноушн|slack|слак|todoist|trello|linear|github|репо|repo`,
    String.raw`asana|clickup|airtable|dropbox|zoom|discord|hubspot|figma|miro`,
    String.raw`outlook|calendly|canva|crm|яндекс\s*почт|granola|таблиц`,
    String.raw`spreadsheets?|sheets?|google (docs|slides)`,
    String.raw`(напиши|скинь|сообщи|передай|отправь)\s+\p{L}+(е|ю|у)(?!\p{L})`,
    String.raw`slack \p{L}+`
  ),
  memory: stems(
    String.raw`запомни|помнишь|забудь|удали|сотри|что ты (про|обо) мне`,
    String.raw`что ты знаешь|памят|в прошлый раз|как обычно|как всегда`,
    String.raw`продолж|всегда|(не )?ем(?!\p{L})|remember|forget`,
    String.raw`what do you know|last time|as usual|usual|always`,
    String.raw`running record|learn from`
  ),
  money: stems(
    String.raw`лимит|трат|без спроса|без спросу|не спрашива|без вопрос`,
    String.raw`без подтвержд|без моего (ок|ok|согласия)|оплачивай|не плати`,
    String.raw`оплат|заплат|плат(и|ит|ишь)(?!\p{L})|пополн|закинь|закинуть`,
    String.raw`переве(ди|сти|ду)\s+(\p{L}+\s+){0,2}\d|перевод\p{L}*\s+(на|по|\d)`,
    String.raw`карт(а|у|ой|ы|е|очк\p{L}*)?(?!\p{L})|привяж|привяз|денег|деньги`,
    String.raw`карт\p{L}*\s*(мир|visa|в сейф|привяз)|привяж`,
    String.raw`сч[её]т (от|за|на оплату)|подписк|автоплат|автопродлен|списыва`,
    String.raw`бюджет|сбп|spend|budget|without asking|pay(?!\p{L})|payment`,
    String.raw`card|charge|subscription|approve|within my range|points`,
    // Taking a standing permission back must find its tool (`tools.ts`).
    String.raw`спрашивай (меня )?(снова|опять)|ask me (again|first)`
  ),
  schedules: stems(
    String.raw`напомн|напомин|кажд\p{L}*|по будням|будн\p{L}* день|ежеднев`,
    String.raw`еженедел|ежемесяч|раз в`,
    String.raw`по (понедельник|вторник|сред|четверг|пятниц|суббот|воскресень)ам`,
    String.raw`по утрам|по вечерам|присылай|расписани|следи|отслеж|наблюд`,
    String.raw`как откроется|когда откроется|как только|прид[её]т`,
    String.raw`сообщи,? когда|напиши,? когда|останови|на паузу|возобнови`,
    String.raw`бот(ов|ы|а)?(?!\p{L})|remind|every`,
    String.raw`each (day|week|morning|evening|monday)|daily|weekly|monthly`,
    String.raw`watch|keep an eye|monitor|the moment|when the window opens`,
    String.raw`schedule|recurring|bots?(?!\p{L})|repeat|follow up|ping me`,
    String.raw`brief me`,
    // So must stopping a schedule.
    // Not a bare «больше не надо»: «мне больше не надо, спасибо» is no
    // schedule.
    String.raw`хватит присыла|больше не (присылай|напоминай|(надо|нужно) (присыла|напомина|писа))`,
    String.raw`отключи напомин|stop (sending|reminding)`,
    String.raw`не (надо|нужно) больше (присыла|напомина|писа)`,
    String.raw`перестань (мне )?(писать|присылать|напоминать)`,
    String.raw`(отмени|убери|удали|перенеси|измени|поменяй|выключи|отключи)\s+(\p{L}+\s+){0,2}(сводк|дайджест|рассылк|напоминан|уведомлени)`,
    String.raw`(cancel|stop|pause|move)\s+(my |the )?(\p{L}+ )?(brief|digest|summary|updates|reminders?)`,
    // A reminder said without the word.
    String.raw`разбуди|пни меня|через (час|полчаса|\d+ мин)|скажи мне (в \d|позвон|напис|купи|сдела|забра)`,
    String.raw`wake me|nudge me|in an hour`
  ),
  files: stems(
    String.raw`презентац|слайд|таблиц|эксел|excel(?!l)|xlsx?(?!\p{L})|csv(?!\p{L})`,
    String.raw`docx?(?!\p{L})|pptx?(?!\p{L})|ворд|диаграмм`,
    // A chart, not a bare «график»: «график дежурств» is a schedule, and so
    // is the one someone is put «в график» or «на график».
    String.raw`(постро|нарису|сдела|начерти|добав|встав)\p{L}*\s+((?!(в|во|на)\s)\p{L}+\s+){0,2}график(?!\p{L}*\s+(дежур|работ|смен|отпуск|заняти|уборк|при[её]м|встреч))`,
    String.raw`график\p{L}*\s+(продаж|расход|доход|трат|выручк|динамик|рост|цен|курс|температур|по (месяц|дн|недел|годам|данн|таблиц))`,
    String.raw`spreadsheets?|slides?(?!\p{L})|charts?(?!\p{L})|presentations?`,
    // Not a bare «deck»: a deck of cards is no slides.
    String.raw`(slide|pitch) deck`
  ),
  images: stems(
    String.raw`нарису|рисун|картинк|изображен|открытк|постер|стикер`,
    String.raw`мем(?!\p{L})|логотип(?!а)|аватар|сгенерир|фот(о|к|ограф)`,
    String.raw`как выглядит|draw|image|picture|photo|logo|memes?|poster`,
    String.raw`illustration|creatives?`
  ),
  games: stems(
    String.raw`игр|сыгра|поигра|виктори|квиз|загадк|крестики|в города|угадай`,
    String.raw`правда или действие|trivia|quiz|game|play(?!\p{L})|riddle`
  ),
  "about-bro": stems(
    String.raw`как ты устроен|как ты работаешь|где (хран|лежат|мои данные)`,
    String.raw`хранятся|кто (видит|обрабат)|кто ещ[её] (видит|читает)`,
    String.raw`третьим лицам|переда\p{L}* (мои|данн|переписк)|конфиденц`,
    String.raw`персональн|что у тебя осталось|что ты хранишь|шифр|модел`,
    String.raw`сервер|облак|данн\p{L}* (обо|про) мне|мои данные|моих данных`,
    String.raw`сейф|парол|логин|импорт|chrome|vault|privacy|how do you work`,
    String.raw`stored|what do you (store|keep)|login|password|guardrails?`,
    String.raw`share my data|who (sees|reads)`
  ),
};

/**
 * The markers a channel puts for what is not text
 * (`agent/lib/inbound-media/turn-content.ts`): a file's label or the word
 * «фото» is not the person's. A voice message's transcript after
 * `[голосовое]` is.
 */
const mediaMarkers =
  /\[(?:фото|документ|голосовое не распозналось|файл:[^\]]*)\]|\[голосовое\]/giu;

/**
 * A file's marker of any type but a picture or a PDF, which the model reads
 * itself: a document for the task agent, or one that did not come through.
 * The type is the last parenthesis before the bracket or the reason.
 */
const documentMarker =
  /\[файл:[^\]]*\((?!image\/|application\/pdf\))[^()\]]*\)(?:, [^\]]*)?\]/u;

/** A photo's marker: meter readings come as photos alone. */
const photoMarker = /\[фото\]/iu;

/** What a person sends with photos when the photos are the message. */
const photoFiller =
  /^(?:\s|[.,!?…:;—-]|вот|держи|лови|на|это|передай|отправь|куда надо|за этот месяц|за месяц)*$/iu;

/** Sites of public services: Госуслуги, the sites it opens, and their kin. */
function publicServiceHost(host: string) {
  return (
    isGosuslugi(host) ||
    signsInWithGosuslugi(host) ||
    [
      "emias.info",
      "lkfl2.nalog.ru",
      "lknpd.nalog.ru",
      "xn--90adear.xn--p1ai",
    ].includes(host) ||
    host.endsWith(".gov.ru")
  );
}

/** Sites where meter readings go. */
function meterReadingsHost(host: string) {
  return ["dom.gosuslugi.ru", "mosenergosbyt.ru"].some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}

/** Bro's own question before a payment (execution-safety.md). */
const paymentQuestion = /Оплачиваю\?|Shall I pay\?/iu;

/** Bro asking for meter readings, as the monthly schedule's report does. */
const readingsQuestion = /показани|сч[её]тчик/iu;

/** A run that went to Госуслуги's sign-in or its screen of access rights. */
const esiaReport = /esia\.gosuslugi\.ru|Предоставление прав доступа/iu;

/** A message's text parts, as one string. */
function messageText(message: ModelMessage) {
  return Array.isArray(message.content)
    ? message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
    : message.content;
}

const taggedMessageSchema = z.object({ kind: z.string() });

/** eve's tag of a user-role message: `user`, `context.*`, `memory.*`… */
function messageKind(message: ModelMessage) {
  return taggedMessageSchema.safeParse(message).data?.kind ?? "user";
}

/** The turn's own messages, without eve's context and the slots' records. */
function turnMessages(input: readonly ModelMessage[]) {
  return input.filter(
    (message) =>
      message.role === "user" &&
      !messageKind(message).startsWith("context.") &&
      !messageKind(message).startsWith("memory.")
  );
}

/**
 * The words of the turn's own messages: what the person wrote or said, or
 * the report a browser run brought. eve's context and the memory slots'
 * records are not the turn's words.
 */
function turnWords(input: readonly ModelMessage[]) {
  return turnMessages(input).map(messageText).join("\n");
}

const filePartSchema = z.object({
  mediaType: z.string(),
  type: z.literal("file"),
});

/**
 * Whether the turn's own messages carry a file the model does not read
 * itself, as the web sends one: not a picture, not a PDF.
 */
function sentDocument(input: readonly ModelMessage[]) {
  return turnMessages(input).some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => {
        const mediaType = filePartSchema
          .safeParse(part)
          .data?.mediaType.toLowerCase();
        return (
          mediaType !== undefined &&
          !mediaType.startsWith("image/") &&
          mediaType !== "application/pdf"
        );
      })
  );
}

/**
 * The marker a channel adds to a workspace's first message ever
 * (`agent/lib/first-contact.ts`). It comes as eve's turn context, which no
 * person or page writes.
 */
function firstContact(input: readonly ModelMessage[]) {
  return input.some(
    (message) =>
      message.role === "user" &&
      messageKind(message).startsWith("context.") &&
      messageText(message).includes("`first-contact`")
  );
}

/** The bare lower-case host of every link a text names. */
function linkedHosts(text: string) {
  return (text.match(/https?:\/\/[^\s<>"'«»]+/giu) ?? []).flatMap((link) => {
    const host = URL.parse(link)?.hostname.toLowerCase();
    return host ? [host.replace(/^www\./u, "")] : [];
  });
}

/** The bare lower-case host of a `browser_task`'s `site`. */
function siteHost(site: string) {
  const host = URL.parse(
    /^https?:\/\//iu.test(site) ? site : `https://${site}`
  )?.hostname.toLowerCase();
  return host ? host.replace(/^www\./u, "") : undefined;
}

const toolCallSchema = z.object({
  input: z.unknown(),
  toolName: z.string(),
  type: z.literal("tool-call"),
});

const toolResultSchema = z.object({
  output: z.unknown(),
  toolName: z.string(),
  type: z.literal("tool-result"),
});

const siteInputSchema = z.object({ site: z.string() });

const sentTextSchema = z.object({ text: z.string() });

const automationReplySchema = z.object({
  replyTo: z.object({ kind: z.literal("automation") }),
});

/** The tools the conversation called, with their input. */
function toolCalls(history: readonly ModelMessage[]) {
  return history.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.flatMap(
          (part) => toolCallSchema.safeParse(part).data ?? []
        )
      : []
  );
}

/** What the conversation's `browser_task` calls returned, as text. */
function browserResults(history: readonly ModelMessage[]) {
  return history.flatMap((message) =>
    message.role === "tool" || message.role === "assistant"
      ? (Array.isArray(message.content) ? message.content : []).flatMap(
          (part) => {
            const result = toolResultSchema.safeParse(part).data;
            return result?.toolName === "browser_task"
              ? [JSON.stringify(result.output)]
              : [];
          }
        )
      : []
  );
}

/** The skills a domain tool of the conversation keeps for later turns. */
function toolSkills(toolName: string): readonly SkillName[] {
  if (
    toolName === "browser_task" ||
    toolName === "list_orders" ||
    toolName === "site_sign_ins"
  ) {
    return ["browser"];
  }
  // A mail's attachment is a file or a picture to pass on.
  if (toolName === "gmail-attachment") return ["google", "images"];
  if (/^(?:gmail|calendar|drive|contacts)-|^connect_google$/u.test(toolName)) {
    return ["google"];
  }
  if (/^(?:notion|slack)-|^(?:apps|connect_app)$/u.test(toolName)) {
    return ["apps"];
  }
  if (toolName.startsWith("schedules-") || toolName === "watch-create") {
    return ["schedules"];
  }
  // A job of the task agent's is followed by its edits («добавь слайд»).
  if (toolName === "task") return ["files"];
  if (toolName === "generate_image" || toolName === "find_images") {
    return ["images"];
  }
  if (toolName === "spend_limit" || toolName === "standing_permission") {
    return ["money"];
  }
  if (
    toolName.startsWith("workstreams__") ||
    /^profile__(?:forget|remove|find|semantic_find)/u.test(toolName)
  ) {
    return ["memory"];
  }
  if (toolName === "privacy" || toolName.startsWith("request_vault")) {
    return ["about-bro"];
  }
  return [];
}

/** What follows from a skill: public services and readings are errands. */
const implied: Partial<Record<SkillName, readonly SkillName[]>> = {
  "gov-services": ["browser"],
  "meter-readings": ["gov-services", "browser"],
};

/** The skills the conversation's tool calls and results keep. */
function historySkills(history: readonly ModelMessage[]) {
  const wanted = new Set<SkillName>();
  let lastSent: unknown;
  for (const { input, toolName } of toolCalls(history)) {
    for (const skill of toolSkills(toolName)) wanted.add(skill);
    if (toolName === "browser_task") {
      const site = siteInputSchema.safeParse(input).data?.site;
      const host = site === undefined ? undefined : siteHost(site);
      if (host !== undefined && publicServiceHost(host)) {
        wanted.add("gov-services");
      }
      if (host !== undefined && meterReadingsHost(host)) {
        wanted.add("meter-readings");
      }
    }
    // Bro's own words to the person: its question before paying (the «да»
    // that follows may answer a report turn about a worker's run) and its
    // ask for readings.
    if (toolName === "send_message") {
      lastSent = input;
      const text = sentTextSchema.safeParse(input).data?.text ?? "";
      if (paymentQuestion.test(text)) {
        wanted.add("browser");
        wanted.add("money");
      }
      if (readingsQuestion.test(text)) wanted.add("meter-readings");
    }
  }
  // The person answers a schedule's report: «хватит», «перенеси на 8»
  // change that schedule.
  if (automationReplySchema.safeParse(lastSent).success) {
    wanted.add("schedules");
  }
  for (const result of browserResults(history)) {
    if (result.includes("NEEDS: payment")) wanted.add("money");
    if (esiaReport.test(result)) wanted.add("gov-services");
  }
  return wanted;
}

/**
 * The skills a turn needs, in the index's order.
 *
 * - `input`: the turn's own messages (eve's `turn.input`): context first,
 *   then the person's message or the report.
 * - `history`: the conversation before the turn.
 * - `browserReport`: the turn is a browser run's report
 *   (`reportedBrowserRunId`).
 */
export function skillsForTurn(turn: {
  readonly browserReport: boolean;
  readonly history: readonly ModelMessage[];
  readonly input: readonly ModelMessage[];
}): SkillName[] {
  const said = turnWords(turn.input);
  const words = said.replace(mediaMarkers, " ");
  const wanted = historySkills(turn.history);
  for (const name of skillNames) {
    if (wordSignals[name]?.test(words)) wanted.add(name);
  }
  if (documentMarker.test(said) || sentDocument(turn.input)) {
    wanted.add("files");
  }
  if (photoMarker.test(said) && photoFiller.test(words)) {
    wanted.add("meter-readings");
  }
  const hosts = linkedHosts(words);
  // A link is most often a site to act on.
  if (hosts.length > 0) wanted.add("browser");
  if (hosts.some(publicServiceHost)) wanted.add("gov-services");
  if (hosts.some(meterReadingsHost)) wanted.add("meter-readings");
  if (appsNamedByPerson(turn.input).length > 0) wanted.add("apps");
  if (firstContact(turn.input)) wanted.add("first-contact");
  if (turn.browserReport) wanted.add("browser");
  for (const name of ["meter-readings", "gov-services"] as const) {
    if (wanted.has(name)) {
      for (const follows of implied[name] ?? []) wanted.add(follows);
    }
  }
  return skillNames.filter((name) => wanted.has(name));
}
