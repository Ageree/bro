import { z } from "zod";
import {
  browserSubmissionSchema,
  paymentCeilingRub,
} from "@shared/browser/submission";
import {
  connectedAppNames,
  connectedAppSchema,
} from "@shared/composio/catalog";
import {
  describeSpendRule,
  describeStandingAction,
  formatRub,
  givenScope,
  normalizeCategory,
  normalizeMerchant,
  type SpendRule,
  type StandingAction,
  standingActionKinds,
  standingMonthCapRub,
} from "@shared/spending/limit";

/**
 * eve titles every approval card «Approve tool call: <tool>», which in a
 * messenger — and in the web chat's own view — is all the person sees. A
 * card is the one place where the person confirms a booking or an order in
 * their name, or lets Bro act and pay without asking from then on, so it
 * says exactly that: what, where, for whom, which of their details go, when
 * and for how much; or which errands, on which sites and up to what sum a
 * standing permission or a spend limit lets through.
 *
 * It reads as Bro's own message in the person's language, not as a form:
 * plain sentences with the values as they are, no field labels, bars or
 * quotes around them, and a plain question at the end that «да», «нет» or
 * the buttons answer. The wording is neutral, since the person may have
 * chosen «вы» or «ты», and Bro's gender is the person's choice too.
 */
const cardText = {
  en: {
    appCall: (tool: string) => `I'll call ${tool} with:`,
    appCallBare: (tool: string) => `I'll call ${tool} with no data.`,
    appDo: (app: string, summary: string) => `In ${app}: ${summary}`,
    appDoBare: (app: string) => `I'll make a call in ${app}.`,
    approve: "Yes",
    askApp: "Go ahead?",
    askBrowser: {
      application: "Submit it?",
      appointment: "Book it?",
      booking: "Book it?",
      job_application: "Send the applications?",
      message: "Send it?",
      order: "Place the order?",
      other: "Go ahead?",
      table: "Book it?",
      taxi: "Order the taxi?",
    },
    askBrowserUnknown: "Go ahead?",
    askCalendarCreate: "Add it?",
    askCalendarDelete: "Delete it?",
    askCalendarUpdate: "Change it?",
    askDraft: "Save the draft?",
    askForget: "Forget it?",
    askForgetAll: "Forget them?",
    askLimitChange: "Change it?",
    askLimitClear: "Take it back?",
    askLimitInclude: "Allow it again?",
    askLimitSet: "Set it?",
    askNotionRead: "Open it?",
    askNotionTask: "Add it?",
    askPermissionRevoke: "Take it back?",
    askPermissionSet: "Allow it?",
    askScheduleCreate: "Set it up?",
    askScheduleUpdate: "Change it?",
    askLook: "Take a look?",
    askSearch: "Search?",
    askSend: "Send it?",
    askSlackRead: "Read them?",
    basket: "In the basket:",
    calendarCreate: (title: string, when: string) =>
      `I'll add this to the calendar: ${title} — ${when}.`,
    calendarDelete: "I'll delete the calendar event",
    calendarDeleteSeries: "I'll delete the whole recurring series",
    calendarDeleteFooter:
      "If it has guests, Google emails them the cancellation.",
    calendarGuests: (guests: string) =>
      `I'll invite ${guests}; Google emails them an invitation.`,
    calendarNewTime: (when: string) => `Moving it to ${when}.`,
    calendarNewTitle: (title: string) => `New title: ${title}`,
    calendarNotes: (notes: string) => `Notes: ${notes}`,
    calendarPlace: (place: string) => `Location: ${place}`,
    calendarUpdate: "I'll change the calendar event",
    calendarUpdateSeries: "I'll change the whole recurring series",
    calendarUpdateFooter: "If it has guests, Google emails them the change.",
    cancel: "No",
    card: "I'll pay with the saved card.",
    cardUpTo: (ceiling: string) =>
      `I'll pay with the saved card, up to ${ceiling}.`,
    cost: (amount: string) => `Cost — ${amount}`,
    emailBcc: (list: string) => `, bcc ${list}`,
    emailCc: (list: string) => `, cc ${list}`,
    emailDraft: (to: string) => `I'll save a Gmail draft to ${to}`,
    emailDraftFooter: "Nothing gets sent.",
    emailDraftReply: (to: string) =>
      `I'll save a Gmail draft of the reply to ${to} in the same thread`,
    emailMore: (count: number) => `… (${String(count)} more characters)`,
    emailReply: (to: string) => `I'll reply to ${to} in the same thread`,
    emailSend: (to: string) => `I'll email ${to}`,
    emailSubject: (subject: string) => `, subject: ${subject}`,
    forWhom: (name: string) => `In the name of ${name}`,
    guarantee: "The saved card goes only as a guarantee, nothing is charged.",
    limitClear: "I'll take back the spend limit rule",
    limitChange: "I'll change the spend limit.",
    limitInclude: "I'll pay without asking again",
    limitSet: (rule: string) =>
      `Spend limit: ${rule}. Within it I'll pay without asking from now on.`,
    memoryForget: (record: string) => `I'll forget this: ${record}`,
    memoryForgetAll: "I'll forget these records:",
    noPersonalData: "; no personal details go to the site.",
    notionDatabase: (name: string) => `In the ${name} database.`,
    notionDue: (due: string) => `Due ${due}`,
    notionNotes: (notes: string) => `Notes: ${notes}`,
    notionRead: (id: string) => `I'll open ${id} in Notion.`,
    notionRecent: "I'll look at the recently edited pages in Notion.",
    notionSearch: (query: string) => `I'll search Notion for ${query}`,
    notionTask: (title: string) => `I'll add a task to Notion: ${title}`,
    onSite: (site: string) => `On ${site}.`,
    permissionFooter:
      "From now on I'll do such errands without asking, in this conversation, until it is taken back; each errand stays on its own site, and background work never uses it.",
    permissionRevoke: (rule: string) =>
      `I'll take back the standing permission: ${rule}.`,
    permissionRevokeAll: "I'll take back every standing permission.",
    permissionSet: (rule: string) => `Standing permission: ${rule}.`,
    personalData: (data: string) => `; the site gets: ${data}.`,
    scheduleCreate: "I'll set up a scheduled task",
    scheduleRunNow: "I'll run it once now, beside its regular runs.",
    scheduleStatuses: {
      active: "I'll resume it.",
      deleted: "I'll delete it.",
      paused: "I'll pause it.",
    },
    scheduleUpdate: "I'll change a scheduled task",
    scheduleWhen: (when: string) => `Schedule: ${when}.`,
    slackMessage: (to: string) => `I'll send this to ${to} in Slack:`,
    slackRead: (from: string) => `I'll read the Slack messages in ${from}`,
    slackSearch: (query: string) => `I'll search Slack for ${query}`,
    slackThread: (thread: string) => ` (thread ${thread})`,
    workstreamForget: (title: string) =>
      `I'll forget the saved work on ${title}`,
    workstreamForgetAll: "I'll forget this saved work:",
  },
  ru: {
    appCall: (tool: string) => `Вызову ${tool} с такими данными:`,
    appCallBare: (tool: string) => `Вызову ${tool} без данных.`,
    appDo: (app: string, summary: string) => `В ${app}: ${summary}`,
    appDoBare: (app: string) => `Сделаю вызов в ${app}.`,
    approve: "Да",
    askApp: "Сделать?",
    askBrowser: {
      application: "Подать?",
      appointment: "Записать?",
      booking: "Забронировать?",
      job_application: "Откликнуться?",
      message: "Отправить?",
      order: "Заказать?",
      other: "Сделать?",
      table: "Забронировать?",
      taxi: "Заказать?",
    },
    askBrowserUnknown: "Оформить?",
    askCalendarCreate: "Добавить?",
    askCalendarDelete: "Удалить?",
    askCalendarUpdate: "Поменять?",
    askDraft: "Сохранить черновик?",
    askForget: "Забыть?",
    askForgetAll: "Забыть?",
    askLimitChange: "Поменять?",
    askLimitClear: "Снять?",
    askLimitInclude: "Вернуть?",
    askLimitSet: "Поставить?",
    askNotionRead: "Открыть?",
    askNotionTask: "Добавить?",
    askPermissionRevoke: "Снять?",
    askPermissionSet: "Разрешить?",
    askScheduleCreate: "Поставить?",
    askScheduleUpdate: "Поменять?",
    askLook: "Посмотреть?",
    askSearch: "Поискать?",
    askSend: "Отправить?",
    askSlackRead: "Прочитать?",
    basket: "В корзине:",
    calendarCreate: (title: string, when: string) =>
      `Добавлю в календарь: ${title} — ${when}.`,
    calendarDelete: "Удалю из календаря событие",
    calendarDeleteSeries: "Удалю из календаря всю серию повторяющихся событий",
    calendarDeleteFooter:
      "Если в событии есть гости, Google пришлёт им отмену.",
    calendarGuests: (guests: string) =>
      `Позову ${guests} — Google пришлёт им приглашение.`,
    calendarNewTime: (when: string) => `Перенесу на ${when}.`,
    calendarNewTitle: (title: string) => `Новое название — ${title}`,
    calendarNotes: (notes: string) => `В описании — ${notes}`,
    calendarPlace: (place: string) => `Место — ${place}`,
    calendarUpdate: "Поменяю событие в календаре",
    calendarUpdateSeries: "Поменяю в календаре всю серию повторяющихся событий",
    calendarUpdateFooter:
      "Если в событии есть гости, Google сообщит им об изменении.",
    cancel: "Нет",
    card: "Оплачу сохранённой картой.",
    cardUpTo: (ceiling: string) =>
      `Оплачу сохранённой картой, не больше ${ceiling}.`,
    cost: (amount: string) => `Стоимость — ${amount}`,
    emailBcc: (list: string) => `, скрытая копия — ${list}`,
    emailCc: (list: string) => `, копия — ${list}`,
    emailDraft: (to: string) => `Сохраню в Gmail черновик письма на ${to}`,
    emailDraftFooter: "Отправлять ничего не буду.",
    emailDraftReply: (to: string) =>
      `Сохраню в Gmail черновик ответа ${to} в той же ветке`,
    emailMore: (count: number) => `… (ещё ${String(count)} зн.)`,
    emailReply: (to: string) => `Отвечу ${to} в той же ветке`,
    emailSend: (to: string) => `Отправлю письмо на ${to}`,
    emailSubject: (subject: string) => `, тема — ${subject}`,
    forWhom: (name: string) => `Оформлю на имя ${name}`,
    guarantee: "Карта уйдёт только в гарантию, списания не будет.",
    limitClear: "Сниму правило лимита трат без спроса",
    limitChange: "Поменяю лимит трат без спроса.",
    limitInclude: "Снова буду платить без спроса",
    limitSet: (rule: string) =>
      `Лимит трат без спроса: ${rule}. В этих пределах дальше буду платить без подтверждения.`,
    memoryForget: (record: string) => `Забуду из памяти: ${record}`,
    memoryForgetAll: "Забуду из памяти эти записи:",
    noPersonalData: ", личные данные сайту не уйдут.",
    notionDatabase: (name: string) => `База — ${name}.`,
    notionDue: (due: string) => `Срок — ${due}`,
    notionNotes: (notes: string) => `В описании — ${notes}`,
    notionRead: (id: string) => `Открою в Notion ${id}.`,
    notionRecent: "Посмотрю в Notion недавно изменённые страницы.",
    notionSearch: (query: string) => `Поищу в Notion: ${query}`,
    notionTask: (title: string) => `Добавлю задачу в Notion: ${title}`,
    onSite: (site: string) => `На сайте ${site}.`,
    permissionFooter:
      "Такие поручения дальше буду делать без спроса — в этом разговоре, пока разрешение не снимут; каждое остаётся на своём сайте, а фоновая работа им не пользуется.",
    permissionRevoke: (rule: string) => `Сниму постоянное разрешение: ${rule}.`,
    permissionRevokeAll: "Сниму все постоянные разрешения.",
    permissionSet: (rule: string) => `Постоянное разрешение: ${rule}.`,
    personalData: (data: string) => `, сайт получит: ${data}.`,
    scheduleCreate: "Поставлю задачу по расписанию",
    scheduleRunNow: "Запущу её один раз сейчас, вне расписания.",
    scheduleStatuses: {
      active: "Возобновлю её.",
      deleted: "Удалю её.",
      paused: "Поставлю её на паузу.",
    },
    scheduleUpdate: "Поменяю задачу по расписанию",
    scheduleWhen: (when: string) => `Расписание — ${when}.`,
    slackMessage: (to: string) => `Отправлю в Slack ${to}:`,
    slackRead: (from: string) => `Прочитаю сообщения в Slack: ${from}`,
    slackSearch: (query: string) => `Поищу в Slack: ${query}`,
    slackThread: (thread: string) => ` (ветка ${thread})`,
    workstreamForget: (title: string) => `Забуду сохранённое дело: ${title}`,
    workstreamForgetAll: "Забуду сохранённые дела:",
  },
} as const;

type CardLanguage = keyof typeof cardText;
type CardText = (typeof cardText)[CardLanguage];

/**
 * One line of the card. The tool's schema already refuses a line break in a
 * field, but a call parked before that, or a site, is drawn all the same: a
 * value that broke its line could pass for another line of the card.
 */
function oneLine(value: string) {
  return value.replaceAll(/[\p{Cc}\u2028\u2029]+/gu, " ").trim();
}

/** A sentence that ends on a value: its full stop, unless it has one. */
function sentence(text: string) {
  return /[.!?…]$/u.test(text) ? text : `${text}.`;
}

/** «заказ корма» opens its sentence as «Заказ корма». */
function capitalized(text: string) {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/** The text after a colon: «Добавить платёж» → «добавить платёж», «CRM» stays. */
function lowerFirst(text: string) {
  const [first = "", second = ""] = text;
  return second === second.toLocaleLowerCase()
    ? first.toLocaleLowerCase() + text.slice(first.length)
    : text;
}

/** The card: its lines, then the question the person answers. */
function card(lines: readonly (string | undefined)[], question: string) {
  return [...lines.filter((line) => line !== undefined), question].join("\n");
}

const confirmedCallSchema = z.object({
  allowPayment: z.boolean().optional(),
  site: z.string().optional(),
  // A call parked before kinds existed still deserves its details.
  submission: browserSubmissionSchema.partial({ kind: true }).extend({
    // Drawn line by line below, so a stray line break costs nothing here.
    amount: z.string().optional(),
    forWhom: z.string(),
    items: z.array(z.string()).optional(),
    personalData: z.array(z.string()),
    what: z.string(),
    when: z.string().optional(),
    where: z.string(),
  }),
});

/**
 * Whether the card pays, and up to what: a card that names the rouble total
 * approves paying it with the small margin the tool allows, and says so.
 */
function paymentLine(
  call: z.infer<typeof confirmedCallSchema>,
  text: CardText
) {
  const { chargeRub } = call.submission;
  if (chargeRub !== undefined) {
    const ceiling = paymentCeilingRub(chargeRub);
    return ceiling === 0 ? text.guarantee : text.cardUpTo(formatRub(ceiling));
  }
  return call.allowPayment === true ? text.card : undefined;
}

/** The card's text for a confirmed `browser_task` call. */
function browserTaskPrompt(
  call: z.infer<typeof confirmedCallSchema>,
  text: CardText
) {
  const { submission } = call;
  const items = submission.items ?? [];
  const details = submission.personalData.map(oneLine).join(", ");
  const cost = [
    submission.amount
      ? sentence(text.cost(oneLine(submission.amount)))
      : undefined,
    paymentLine(call, text),
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  const where = oneLine(submission.where);
  return card(
    [
      sentence(
        `${capitalized(oneLine(submission.what))} — ${submission.when ? `${where}, ${oneLine(submission.when)}` : where}`
      ),
      // A basket is confirmed line by line: what is in it, not only its total.
      ...(items.length > 0
        ? [text.basket, ...items.map((item) => `• ${oneLine(item)}`)]
        : []),
      `${text.forWhom(oneLine(submission.forWhom))}${details ? text.personalData(details) : text.noPersonalData}`,
      cost || undefined,
      call.site ? text.onSite(oneLine(call.site)) : undefined,
    ],
    submission.kind === undefined
      ? text.askBrowserUnknown
      : text.askBrowser[submission.kind]
  );
}

const standingKindLabelsEn: Record<
  NonNullable<StandingAction["kind"]>,
  string
> = {
  appointment: "appointments with doctors and services",
  application: "applications and requests",
  booking: "bookings of stays, tickets and rentals",
  job_application: "job applications",
  message: "messages and requests to tradespeople",
  order: "orders of goods and food",
  table: "restaurant table bookings",
  taxi: "taxi rides",
};

function describeStandingActionIn(
  language: CardLanguage,
  rule: StandingAction
) {
  if (language === "ru") return describeStandingAction(rule);
  return [
    `${rule.kind === null ? "everything" : standingKindLabelsEn[rule.kind]} without asking`,
    rule.merchant === null ? "on any site" : `on ${rule.merchant}`,
    rule.maxRub === null
      ? "free ones only"
      : `up to ${formatRub(rule.maxRub)} per errand and ${formatRub(standingMonthCapRub(rule))} a month`,
  ].join(", ");
}

function describeSpendRuleIn(language: CardLanguage, rule: SpendRule) {
  if (language === "ru") return describeSpendRule(rule);
  return [
    `up to ${formatRub(rule.limitRub)} a month`,
    rule.merchant ? `on ${rule.merchant}` : undefined,
    rule.category ? `on «${rule.category}»` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
}

const standingCallSchema = z.object({
  action: z.enum(["read", "allow", "revoke"]),
  kind: z.enum(standingActionKinds).optional(),
  maxRub: z.number().optional(),
  merchant: z.string().optional(),
  monthRub: z.number().optional(),
});

/**
 * The card for a `standing_permission` change: the permission exactly as it
 * will read in the cabinet — which errands, on which sites (every site, when
 * it names none), up to what per errand and per month.
 */
function standingPermissionPrompt(
  call: z.infer<typeof standingCallSchema>,
  text: CardText,
  language: CardLanguage
) {
  if (call.action === "read") return undefined;
  const site = givenScope(call.merchant);
  const rule: StandingAction = {
    kind: call.kind ?? null,
    maxRub: call.maxRub ?? null,
    merchant:
      site === undefined ? null : (normalizeMerchant(site) ?? oneLine(site)),
    monthRub: call.maxRub === undefined ? null : (call.monthRub ?? null),
  };
  if (call.action === "revoke") {
    return card(
      [
        call.kind === undefined && site === undefined
          ? text.permissionRevokeAll
          : text.permissionRevoke(describeStandingActionIn(language, rule)),
      ],
      text.askPermissionRevoke
    );
  }
  return card(
    [
      text.permissionSet(describeStandingActionIn(language, rule)),
      text.permissionFooter,
    ],
    text.askPermissionSet
  );
}

const spendLimitCallSchema = z.object({
  action: z.enum(["read", "set", "clear", "exclude", "include"]),
  category: z.string().optional(),
  limitRub: z.number().optional(),
  merchant: z.string().optional(),
});

/** The card for a `spend_limit` change that lets Bro pay more on its own. */
function spendLimitPrompt(
  call: z.infer<typeof spendLimitCallSchema>,
  text: CardText,
  language: CardLanguage
) {
  if (call.action === "read") return undefined;
  const shop = givenScope(call.merchant);
  const merchant =
    shop === undefined ? null : (normalizeMerchant(shop) ?? oneLine(shop));
  const named = givenScope(call.category);
  const category =
    named === undefined ? null : (normalizeCategory(named) ?? oneLine(named));
  const scope = [merchant, category].filter((part) => part !== null).join(", ");
  const scoped = (lead: string) => sentence(scope ? `${lead}: ${scope}` : lead);
  if (call.action === "set" && call.limitRub !== undefined) {
    return card(
      [
        text.limitSet(
          describeSpendRuleIn(language, {
            category,
            limitRub: call.limitRub,
            merchant,
          })
        ),
      ],
      text.askLimitSet
    );
  }
  if (call.action === "include") {
    return card([scoped(text.limitInclude)], text.askLimitInclude);
  }
  if (call.action === "clear") {
    return card([scoped(text.limitClear)], text.askLimitClear);
  }
  return card([text.limitChange], text.askLimitChange);
}

const notionTaskCallSchema = z.object({
  database: z.string().optional(),
  due: z.string().optional(),
  notes: z.string().optional(),
  title: z.string(),
});

/** The card for adding a Notion task: the task as it will read there. */
function notionTaskPrompt(
  call: z.infer<typeof notionTaskCallSchema>,
  text: CardText
) {
  return card(
    [
      sentence(text.notionTask(oneLine(call.title))),
      call.due ? sentence(text.notionDue(oneLine(call.due))) : undefined,
      call.database ? text.notionDatabase(oneLine(call.database)) : undefined,
      call.notes ? sentence(text.notionNotes(oneLine(call.notes))) : undefined,
    ],
    text.askNotionTask
  );
}

const slackMessageCallSchema = z.object({ text: z.string(), to: z.string() });

/** The card for a Slack message: who gets it and exactly what it says. */
function slackMessagePrompt(
  call: z.infer<typeof slackMessageCallSchema>,
  text: CardText
) {
  return [
    text.slackMessage(oneLine(call.to)),
    "",
    oneLine(call.text),
    "",
    text.askSend,
  ].join("\n");
}

const emailCallSchema = z.object({
  bcc: z.array(z.string()).default([]),
  body: z.string(),
  cc: z.array(z.string()).default([]),
  replyToMessageId: z.string().optional(),
  subject: z.string().optional(),
  to: z.array(z.string()).min(1),
});

/** The part of an email's text a card shows: enough for any usual reply. */
const emailBodyMaxLength = 2_500;
const emailBodyMaxLines = 40;

/**
 * The email's text as the card quotes it: as it will be sent, between blank
 * lines after the sentence that names who gets it, and cut with a note of
 * how much is left when it is longer than a card holds.
 */
function quotedBody(body: string, text: CardText) {
  const normalized = body
    .replaceAll(/\r\n?/gu, "\n")
    .replaceAll(/[^\S\n]+$/gmu, "")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
  const lines = normalized.split("\n").slice(0, emailBodyMaxLines);
  let shown = "";
  for (const line of lines) {
    const next = shown ? `${shown}\n${line}` : line;
    if (next.length > emailBodyMaxLength) {
      shown = next.slice(0, emailBodyMaxLength);
      break;
    }
    shown = next;
  }
  const quoted = shown.split("\n").map((line) => oneLine(line));
  const rest = normalized.length - shown.length;
  return rest > 0 ? [...quoted, text.emailMore(rest)] : quoted;
}

/**
 * The card for an email Bro sends or drafts in the person's name: who gets
 * it, in which thread or under which subject, and the text itself.
 */
function emailPrompt(
  call: z.infer<typeof emailCallSchema>,
  text: CardText,
  draft: boolean
) {
  const list = (addresses: readonly string[]) =>
    addresses.map(oneLine).join(", ");
  const to = list(call.to);
  const reply = call.replyToMessageId !== undefined;
  let lead: string;
  if (draft) lead = reply ? text.emailDraftReply(to) : text.emailDraft(to);
  else lead = reply ? text.emailReply(to) : text.emailSend(to);
  const subject = call.subject ? oneLine(call.subject) : "";
  const header = [
    lead,
    subject ? text.emailSubject(subject) : "",
    call.cc.length > 0 ? text.emailCc(list(call.cc)) : "",
    call.bcc.length > 0 ? text.emailBcc(list(call.bcc)) : "",
  ].join("");
  return [
    draft ? `${sentence(header)} ${text.emailDraftFooter}` : sentence(header),
    "",
    ...quotedBody(call.body, text),
    "",
    draft ? text.askDraft : text.askSend,
  ].join("\n");
}

/** A moment as the tool received it: wall clock and the offset it is in. */
const isoMomentPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u;

function parsedMoment(value: string) {
  const match = isoMomentPattern.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, offset] = match;
  return {
    date: `${year ?? ""}-${month ?? ""}-${day ?? ""}`,
    day: new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))),
    offset: offset ?? "Z",
    time: `${hour ?? ""}:${minute ?? ""}`,
  };
}

/** `UTC+3`, `UTC+5:30`, `UTC−4`: the offset as people read it. */
function offsetLabel(offset: string) {
  if (offset === "Z" || offset === "+00:00" || offset === "-00:00") {
    return "UTC";
  }
  const [hours = "00", minutes = "00"] = offset.slice(1).split(":");
  const sign = offset.startsWith("-") ? "−" : "+";
  return `UTC${sign}${String(Number(hours))}${minutes === "00" ? "" : `:${minutes}`}`;
}

/** An offset such as `+03:00` or `Z`, in minutes east of UTC. */
function offsetMinutes(offset: string) {
  if (offset === "Z") return 0;
  const [hours = "0", minutes = "0"] = offset.slice(1).split(":");
  const total = Number(hours) * 60 + Number(minutes);
  return offset.startsWith("-") ? -total : total;
}

/**
 * How far `timeZone` is ahead of UTC at `at`, in minutes, or nothing when
 * the zone is unknown to this browser or server.
 */
function zoneOffsetAt(at: number, timeZone: string) {
  try {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    })
      .formatToParts(new Date(at))
      .find((part) => part.type === "timeZoneName")?.value;
    const offset = /^GMT(?:([+-]\d{2}):?(\d{2}))?$/u.exec(name ?? "");
    if (!offset) return undefined;
    const [, hours, minutes = "00"] = offset;
    return hours === undefined ? 0 : offsetMinutes(`${hours}:${minutes}`);
  } catch {
    return undefined;
  }
}

/**
 * The zone's name for a time written in `offset`, only when that zone's
 * clock shows this offset then: «11:30 (Europe/Moscow)» next to a UTC time
 * would read as Moscow time for an event Google books three hours later.
 */
function zoneName(
  timeZone: string | undefined,
  moment: NonNullable<ReturnType<typeof parsedMoment>>,
  at: number
) {
  if (!timeZone || /^(?:utc|etc\/utc|gmt|etc\/gmt)$/iu.test(timeZone.trim())) {
    return "";
  }
  return zoneOffsetAt(at, timeZone.trim()) === offsetMinutes(moment.offset)
    ? `${oneLine(timeZone)}, `
    : "";
}

/** The weekday and date of a moment, as the card language writes it. */
function dayLabel(day: Date, language: CardLanguage) {
  return new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    weekday: "short",
  }).format(day);
}

/** One moment on the clock it was written in: «чт, 1 окт., 10:00 (UTC+3)». */
function momentLabel(value: string, language: CardLanguage) {
  const moment = parsedMoment(value);
  return moment
    ? `${dayLabel(moment.day, language)}, ${moment.time} (${offsetLabel(moment.offset)})`
    : oneLine(value);
}

/**
 * When an event happens, on the clock its times were written in: the
 * weekday and date, the hours, and the zone — «чт, 1 окт., 14:30–15:00
 * (Europe/Moscow, UTC+3)». The card shows the times exactly as the call
 * carries them, never converted, so it cannot drift from what Google gets;
 * the zone's name joins them only when its clock agrees.
 */
function eventWhen(
  start: string,
  end: string,
  timeZone: string | undefined,
  language: CardLanguage
) {
  const from = parsedMoment(start);
  const to = parsedMoment(end);
  if (!from || !to) return `${oneLine(start)} – ${oneLine(end)}`;
  const span =
    from.date === to.date
      ? `${dayLabel(from.day, language)}, ${from.time}–${to.time}`
      : `${dayLabel(from.day, language)}, ${from.time} – ${dayLabel(to.day, language)}, ${to.time}`;
  const named = zoneName(timeZone, from, Date.parse(start));
  return `${span} (${named}${offsetLabel(from.offset)})`;
}

const calendarCreateCallSchema = z.object({
  attendees: z.array(z.string()).default([]),
  description: z.string().optional(),
  end: z.string(),
  location: z.string().optional(),
  start: z.string(),
  summary: z.string(),
  timezone: z.string().optional(),
});

/** Notes on a card: one line, cut where a card would get long. */
function notesLine(notes: string) {
  const line = oneLine(notes);
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/**
 * The card for a new event: its title, when on which clock, where, who is
 * invited — and that Google mails the guests, since that is what reaches
 * other people.
 */
function calendarCreatePrompt(
  call: z.infer<typeof calendarCreateCallSchema>,
  text: CardText,
  language: CardLanguage
) {
  return card(
    [
      text.calendarCreate(
        oneLine(call.summary),
        eventWhen(call.start, call.end, call.timezone, language)
      ),
      call.location
        ? sentence(text.calendarPlace(oneLine(call.location)))
        : undefined,
      call.attendees.length > 0
        ? text.calendarGuests(call.attendees.map(oneLine).join(", "))
        : undefined,
      call.description
        ? sentence(text.calendarNotes(notesLine(call.description)))
        : undefined,
    ],
    text.askCalendarCreate
  );
}

const calendarUpdateCallSchema = z.object({
  description: z.string().optional(),
  end: z.string().optional(),
  eventStart: z.string().optional(),
  eventTitle: z.string().optional(),
  series: z.boolean().optional(),
  location: z.string().optional(),
  start: z.string().optional(),
  summary: z.string().optional(),
  timezone: z.string().optional(),
});

/**
 * The event a change or deletion names: its title (none for a call parked
 * before titles) and, for one event, when it starts; a whole recurring
 * series is said to be one.
 */
function eventHeading(
  call: {
    readonly eventStart?: string | undefined;
    readonly eventTitle?: string | undefined;
    readonly series?: boolean | undefined;
  },
  single: string,
  series: string,
  language: CardLanguage
) {
  const when =
    call.series !== true && call.eventStart
      ? momentLabel(call.eventStart, language)
      : undefined;
  const title = call.eventTitle ? oneLine(call.eventTitle) : undefined;
  const lead = call.series === true ? series : single;
  if (title) return sentence(`${lead}: ${when ? `${title} — ${when}` : title}`);
  return sentence(when ? `${lead} ${when}` : lead);
}

/** The card for moving or changing an event: which one, and what changes. */
function calendarUpdatePrompt(
  call: z.infer<typeof calendarUpdateCallSchema>,
  text: CardText,
  language: CardLanguage
) {
  return card(
    [
      eventHeading(
        call,
        text.calendarUpdate,
        text.calendarUpdateSeries,
        language
      ),
      call.start !== undefined && call.end !== undefined
        ? text.calendarNewTime(
            eventWhen(call.start, call.end, call.timezone, language)
          )
        : undefined,
      call.summary
        ? sentence(text.calendarNewTitle(oneLine(call.summary)))
        : undefined,
      call.location
        ? sentence(text.calendarPlace(oneLine(call.location)))
        : undefined,
      call.description
        ? sentence(text.calendarNotes(notesLine(call.description)))
        : undefined,
      text.calendarUpdateFooter,
    ],
    text.askCalendarUpdate
  );
}

/**
 * Longest card text a channel shows whole: Telegram cuts an approval card
 * at 4,000 characters, so a card that would run longer is not shown at all
 * and the call is refused instead (`appsCardFits`).
 */
const approvalCardMaxLength = 3_500;

/**
 * What forgetting several records at once shows: every record by its own
 * text, or every saved work by its title, one per line.
 */
function forgetAllPrompt(
  heading: string,
  names: readonly string[],
  question: string
) {
  return card(
    [heading, ...names.map((name) => `• ${oneLine(name)}`)],
    question
  );
}

/**
 * Whether the card of forgetting these records, or this saved work, at once
 * shows every one of them in every language and channel. The approval
 * policy sends a longer call back to be split.
 */
export function forgetAllCardFits(
  kind: "memory" | "workstreams",
  names: readonly string[]
) {
  return Object.values(cardText).every(
    (text) =>
      forgetAllPrompt(
        kind === "memory" ? text.memoryForgetAll : text.workstreamForgetAll,
        names,
        text.askForgetAll
      ).length <= approvalCardMaxLength
  );
}

const appsCallSchema = z.object({
  action: z.literal("run"),
  app: z.string(),
  arguments: z.string().optional(),
  summary: z.string().optional(),
  tool: z.string(),
});

/** The app an `apps` card names, as the person knows it. */
function appName(app: string) {
  if (app === "google") return "Google";
  const known = connectedAppSchema.safeParse(app);
  return known.success ? connectedAppNames[known.data] : oneLine(app);
}

/**
 * The argument lines of an `apps` card: every argument by name with its
 * whole value, text as it is and anything else as JSON. Nothing is cut: a
 * card that would be too long refuses the call rather than hide its tail.
 */
function argumentLines(argumentsJson: string | undefined) {
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson ?? "{}");
  } catch {
    return [oneLine(argumentsJson ?? "")];
  }
  const entries = Object.entries(
    z.record(z.string(), z.json()).safeParse(value).data ?? {}
  );
  return entries.map(
    ([name, item]) =>
      `  ${oneLine(name)}: ${oneLine(z.string().safeParse(item).data ?? JSON.stringify(item))}`
  );
}

/**
 * The card for an `apps` call: which app, what the call does in the model's
 * own words, the exact tool, and every argument it sends in full, so the
 * words cannot promise less than the call does.
 */
function appsPrompt(call: z.infer<typeof appsCallSchema>, text: CardText) {
  const app = appName(call.app);
  const summary = call.summary ? lowerFirst(oneLine(call.summary)) : "";
  const tool = oneLine(call.tool);
  const args = argumentLines(call.arguments).filter((line) => line.trim());
  return card(
    [
      summary ? sentence(text.appDo(app, summary)) : text.appDoBare(app),
      ...(args.length > 0
        ? [text.appCall(tool), ...args]
        : [text.appCallBare(tool)]),
    ],
    text.askApp
  );
}

/**
 * Whether the card of an `apps` call shows all of it in every language and
 * channel. The approval policy refuses a call whose card would not.
 */
export function appsCardFits(
  call: Omit<z.infer<typeof appsCallSchema>, "action">
) {
  const run = { ...call, action: "run" as const };
  return Object.values(cardText).every(
    (text) => appsPrompt(run, text).length <= approvalCardMaxLength
  );
}

/**
 * The card for a Notion or Slack read, shown only in a turn the person did
 * not start (the report of a browser run, whose text a page writes): what
 * would be read, so a page cannot quietly send Bro through their workspace.
 */
function connectedAppReadPrompt(
  action: { readonly input: unknown; readonly toolName: string },
  text: CardText
) {
  if (action.toolName === "notion-search") {
    const call = z
      .object({ query: z.string().optional() })
      .safeParse(action.input);
    if (!call.success) return undefined;
    const { query } = call.data;
    return query
      ? card([sentence(text.notionSearch(oneLine(query)))], text.askSearch)
      : card([text.notionRecent], text.askLook);
  }
  if (action.toolName === "notion-read") {
    const call = z.object({ id: z.string() }).safeParse(action.input);
    return call.success
      ? card([text.notionRead(oneLine(call.data.id))], text.askNotionRead)
      : undefined;
  }
  if (action.toolName === "slack-read") {
    const call = z
      .object({ from: z.string(), threadTs: z.string().optional() })
      .safeParse(action.input);
    if (!call.success) return undefined;
    const thread = call.data.threadTs
      ? text.slackThread(oneLine(call.data.threadTs))
      : "";
    return card(
      [sentence(`${text.slackRead(oneLine(call.data.from))}${thread}`)],
      text.askSlackRead
    );
  }
  if (action.toolName === "slack-search") {
    const call = z.object({ query: z.string() }).safeParse(action.input);
    return call.success
      ? card(
          [sentence(text.slackSearch(oneLine(call.data.query)))],
          text.askSearch
        )
      : undefined;
  }
  return undefined;
}

const scheduleCallSchema = z.object({
  prompt: z.string().optional(),
  runNow: z.boolean().optional(),
  status: z.enum(["active", "paused", "deleted"]).optional(),
  timing: z
    .object({
      at: z.string().optional(),
      everyMinutes: z.number().optional(),
      kind: z.string(),
    })
    .catchall(z.unknown())
    .optional(),
});

/** When a schedule runs, as plainly as its timing says it. */
function scheduleWhen(
  timing: NonNullable<z.infer<typeof scheduleCallSchema>["timing"]>
) {
  if (timing.kind === "once" && timing.at !== undefined) {
    const moment =
      /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u.exec(
        timing.at
      );
    return moment
      ? `${moment[1] ?? ""} ${moment[2] ?? ""} (UTC${moment[3] === "Z" ? "" : (moment[3] ?? "")})`
      : oneLine(timing.at);
  }
  if (timing.kind === "interval" && timing.everyMinutes !== undefined) {
    return `${String(timing.everyMinutes)} min`;
  }
  return oneLine(
    Object.entries(timing)
      .filter(([key]) => key !== "kind")
      .map(([key, value]) => `${key} ${JSON.stringify(value)}`)
      .join(", ")
  );
}

/**
 * The card for a schedule set up or changed in a turn the person did not
 * start — a browser run's report: what the task will do, word for word, and
 * when, since a worker later runs it as the person's own.
 */
function schedulePrompt(
  call: z.infer<typeof scheduleCallSchema>,
  text: CardText,
  created: boolean
) {
  const lead = created ? text.scheduleCreate : text.scheduleUpdate;
  return card(
    [
      sentence(
        call.prompt === undefined ? lead : `${lead}: ${oneLine(call.prompt)}`
      ),
      call.timing === undefined
        ? undefined
        : text.scheduleWhen(scheduleWhen(call.timing)),
      call.status === undefined
        ? undefined
        : text.scheduleStatuses[call.status],
      call.runNow === true ? text.scheduleRunNow : undefined,
    ],
    created ? text.askScheduleCreate : text.askScheduleUpdate
  );
}

/** The approval card's text for the call, read from its input, or none. */
function cardPrompt(
  action: { readonly input: unknown; readonly toolName: string },
  language: CardLanguage
) {
  const text = cardText[language];
  if (action.toolName === "browser_task") {
    const call = confirmedCallSchema.safeParse(action.input);
    return call.success ? browserTaskPrompt(call.data, text) : undefined;
  }
  if (action.toolName === "standing_permission") {
    const call = standingCallSchema.safeParse(action.input);
    return call.success
      ? standingPermissionPrompt(call.data, text, language)
      : undefined;
  }
  if (action.toolName === "spend_limit") {
    const call = spendLimitCallSchema.safeParse(action.input);
    return call.success
      ? spendLimitPrompt(call.data, text, language)
      : undefined;
  }
  if (action.toolName === "notion-add-task") {
    const call = notionTaskCallSchema.safeParse(action.input);
    return call.success ? notionTaskPrompt(call.data, text) : undefined;
  }
  if (action.toolName === "slack-send-message") {
    const call = slackMessageCallSchema.safeParse(action.input);
    return call.success ? slackMessagePrompt(call.data, text) : undefined;
  }
  if (action.toolName === "apps") {
    const call = appsCallSchema.safeParse(action.input);
    return call.success ? appsPrompt(call.data, text) : undefined;
  }
  if (action.toolName === "gmail-send" || action.toolName === "gmail-draft") {
    const call = emailCallSchema.safeParse(action.input);
    return call.success
      ? emailPrompt(call.data, text, action.toolName === "gmail-draft")
      : undefined;
  }
  if (action.toolName === "calendar-create-event") {
    const call = calendarCreateCallSchema.safeParse(action.input);
    return call.success
      ? calendarCreatePrompt(call.data, text, language)
      : undefined;
  }
  if (action.toolName === "calendar-update-event") {
    const call = calendarUpdateCallSchema.safeParse(action.input);
    return call.success
      ? calendarUpdatePrompt(call.data, text, language)
      : undefined;
  }
  if (action.toolName === "calendar-delete-event") {
    const call = z
      .object({
        eventStart: z.string().optional(),
        eventTitle: z.string().optional(),
        series: z.boolean().optional(),
      })
      .safeParse(action.input);
    return call.success
      ? card(
          [
            eventHeading(
              call.data,
              text.calendarDelete,
              text.calendarDeleteSeries,
              language
            ),
            text.calendarDeleteFooter,
          ],
          text.askCalendarDelete
        )
      : undefined;
  }
  const read = connectedAppReadPrompt(action, text);
  if (read !== undefined) return read;
  if (
    action.toolName === "schedules-create" ||
    action.toolName === "schedules-update"
  ) {
    const call = scheduleCallSchema.safeParse(action.input);
    return call.success
      ? schedulePrompt(call.data, text, action.toolName === "schedules-create")
      : undefined;
  }
  // Forgetting what another conversation saved: the record as it reads.
  if (action.toolName === "profile__remove_memory") {
    const call = z.object({ text: z.string() }).safeParse(action.input);
    return call.success
      ? card(
          [sentence(text.memoryForget(oneLine(call.data.text)))],
          text.askForget
        )
      : undefined;
  }
  if (action.toolName === "profile__forget_all") {
    const call = z
      .object({ records: z.array(z.object({ text: z.string() })) })
      .safeParse(action.input);
    return call.success
      ? forgetAllPrompt(
          text.memoryForgetAll,
          call.data.records.map((record) => record.text),
          text.askForgetAll
        )
      : undefined;
  }
  if (action.toolName === "workstreams__forget_all") {
    const call = z
      .object({ workstreams: z.array(z.object({ title: z.string() })) })
      .safeParse(action.input);
    return call.success
      ? forgetAllPrompt(
          text.workstreamForgetAll,
          call.data.workstreams.map((workstream) => workstream.title),
          text.askForgetAll
        )
      : undefined;
  }
  // The saved work by the title its policy checked against the record; a
  // call parked before titles were passed is named by its id.
  if (action.toolName === "workstreams__forget") {
    const call = z
      .object({ id: z.string(), title: z.string().optional() })
      .safeParse(action.input);
    return call.success
      ? card(
          [
            sentence(
              text.workstreamForget(oneLine(call.data.title ?? call.data.id))
            ),
          ],
          text.askForget
        )
      : undefined;
  }
  return undefined;
}

/**
 * The same approval request with the card's text and buttons in the
 * person's language. Everything the answer is matched by — the request id
 * and the option ids — stays as eve made it. Any other request, and a call
 * whose input cannot be read, is left as it was.
 */
export function withApprovalCard<
  TRequest extends {
    readonly action: { readonly input: unknown; readonly toolName: string };
    readonly kind: string;
    readonly options?: readonly {
      readonly id: string;
      readonly label: string;
    }[];
    readonly prompt: string;
  },
>(request: TRequest, language: CardLanguage): TRequest {
  if (request.kind !== "tool-approval") return request;
  const prompt = cardPrompt(request.action, language);
  if (prompt === undefined) return request;
  const text = cardText[language];
  return {
    ...request,
    options: request.options?.map((option) =>
      option.id === "approve" || option.id === "cancel"
        ? { ...option, label: text[option.id] }
        : option
    ),
    prompt,
  };
}
