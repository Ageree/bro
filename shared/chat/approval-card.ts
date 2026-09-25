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
 * says exactly that, in their language: what, where, for whom, which of
 * their details go, when and for how much; or which errands, on which sites
 * and up to what sum a standing permission or a spend limit lets through.
 * The wording is neutral, since the person may have chosen «вы» or «ты».
 */
const cardText = {
  en: {
    amount: "Cost",
    app: "App",
    appAction: "Action",
    appArguments: "Data",
    appTool: "Tool",
    approve: "Approve",
    calendarCreate: "Create a calendar event:",
    calendarDelete: "Delete the calendar event",
    calendarDeleteFooter:
      "If the event has guests, Google emails them the cancellation.",
    calendarGuests: "Guests",
    calendarInvitation: "Google emails the guests an invitation.",
    calendarNewTime: "New time",
    calendarNewTitle: "New title",
    calendarNotes: "Notes",
    calendarUpdate: "Change the calendar event",
    calendarUpdateFooter:
      "If the event has guests, Google emails them the change.",
    cancel: "Cancel",
    card: "Pays with the saved card",
    cardUpTo: "Pays with the saved card, up to",
    emailBcc: "Bcc",
    emailBody: "Text",
    emailCc: "Cc",
    emailDraft: "Save a draft in Gmail (nothing is sent):",
    emailMore: (count: number) => `… (${String(count)} more characters)`,
    emailReply: "Reply in the thread",
    emailReplyUnnamed: "Reply in the thread of the email",
    emailSend: "Send an email:",
    emailSubject: "Subject",
    emailTo: "To",
    forWhom: "In the name of",
    guarantee: "The saved card as a guarantee only, nothing charged",
    items: "Items",
    limitChange: "Change the spend limit:",
    limitClear: "Take back the rule",
    limitInclude: "Pay without asking again on",
    limitSet:
      "Spend limit — payments within it go through without asking from now on:",
    memoryForget: "Forget this from memory:",
    notionDatabase: "Database",
    notionDue: "Due",
    notionNotes: "Notes",
    notionRead: "Open in Notion:",
    notionRecent: "recently edited pages",
    notionSearch: "Search Notion:",
    notionTask: "Add a task to Notion:",
    permissionFooter:
      "It holds in the conversation until it is taken back; each errand stays on its own site, and background work never uses it.",
    permissionRevoke: "Take back the standing permission:",
    permissionSet:
      "Standing permission — such errands go ahead without asking from now on:",
    personalData: "Details sent",
    scheduleCreate: "Set up a scheduled task:",
    scheduleStatus: "Status",
    scheduleStatuses: {
      active: "resume",
      deleted: "delete",
      paused: "pause",
    },
    scheduleUpdate: "Change a scheduled task:",
    site: "Site",
    slackMessage: "Send a Slack message:",
    slackRead: "Read Slack messages:",
    slackSearch: "Search Slack:",
    slackText: "Text",
    slackThread: "thread",
    slackTo: "To",
    title: "Confirm before this is done in your name:",
    when: "When",
    what: "What",
    where: "Where",
    workstreamForget: "Forget the saved work on",
  },
  ru: {
    amount: "Стоимость",
    app: "Приложение",
    appAction: "Действие",
    appArguments: "Данные",
    appTool: "Инструмент",
    approve: "Подтвердить",
    calendarCreate: "Создать событие в календаре:",
    calendarDelete: "Удалить событие из календаря",
    calendarDeleteFooter:
      "Если в событии есть гости, Google пришлёт им отмену.",
    calendarGuests: "Гости",
    calendarInvitation: "Гостям уйдёт приглашение от Google.",
    calendarNewTime: "Новое время",
    calendarNewTitle: "Новое название",
    calendarNotes: "Заметки",
    calendarUpdate: "Изменить событие в календаре",
    calendarUpdateFooter:
      "Если в событии есть гости, Google сообщит им об изменении.",
    cancel: "Отмена",
    card: "Оплата сохранённой картой",
    cardUpTo: "Оплата сохранённой картой, не больше",
    emailBcc: "Скрытая копия",
    emailBody: "Текст",
    emailCc: "Копия",
    emailDraft: "Сохранить черновик в Gmail (ничего не отправляется):",
    emailMore: (count: number) => `… (ещё ${String(count)} зн.)`,
    emailReply: "Ответ в ветке",
    emailReplyUnnamed: "Ответ в ветке письма",
    emailSend: "Отправить письмо:",
    emailSubject: "Тема",
    emailTo: "Кому",
    forWhom: "От чьего имени",
    guarantee: "Сохранённая карта только в гарантию, без списания",
    items: "Состав",
    limitChange: "Изменение лимита трат без спроса:",
    limitClear: "Снять правило",
    limitInclude: "Снова платить без спроса",
    limitSet:
      "Лимит трат без спроса — в этих пределах оплата дальше без подтверждения:",
    memoryForget: "Забыть из памяти:",
    notionDatabase: "База",
    notionDue: "Срок",
    notionNotes: "Заметки",
    notionRead: "Открыть в Notion:",
    notionRecent: "недавно изменённые страницы",
    notionSearch: "Найти в Notion:",
    notionTask: "Добавить задачу в Notion:",
    permissionFooter:
      "Действует в разговоре, пока его не снимут; каждое поручение остаётся на своём сайте, фоновая работа им не пользуется.",
    permissionRevoke: "Снять постоянное разрешение:",
    permissionSet:
      "Постоянное разрешение — такие поручения дальше без подтверждения:",
    personalData: "Какие данные уйдут",
    scheduleCreate: "Поставить задачу по расписанию:",
    scheduleStatus: "Статус",
    scheduleStatuses: {
      active: "возобновить",
      deleted: "удалить",
      paused: "поставить на паузу",
    },
    scheduleUpdate: "Изменить задачу по расписанию:",
    site: "Сайт",
    slackMessage: "Отправить сообщение в Slack:",
    slackRead: "Прочитать сообщения в Slack:",
    slackSearch: "Найти в Slack:",
    slackText: "Текст",
    slackThread: "ветка",
    slackTo: "Кому",
    title: "Подтверждение действия:",
    when: "Когда",
    what: "Что",
    where: "Где",
    workstreamForget: "Забыть сохранённое дело",
  },
} as const;

type CardLanguage = keyof typeof cardText;
type CardText = (typeof cardText)[CardLanguage];

/**
 * One line of the card. The tool's schema already refuses a line break in a
 * field, but a call parked before that, or a site, is drawn all the same: a
 * value that broke its line could pass for another field of the card.
 */
function oneLine(value: string) {
  return value.replaceAll(/[\p{Cc}\u2028\u2029]+/gu, " ").trim();
}

const confirmedCallSchema = z.object({
  allowPayment: z.boolean().optional(),
  site: z.string().optional(),
  // The card does not show the kind, and a call parked before kinds existed
  // still deserves its details.
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
    return ceiling === 0
      ? text.guarantee
      : `${text.cardUpTo} ${formatRub(ceiling)}`;
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
  return [
    text.title,
    `${text.what}: ${oneLine(submission.what)}`,
    // A basket is confirmed line by line: what is in it, not only its total.
    ...(items.length > 0
      ? [`${text.items}:`, ...items.map((item) => `• ${oneLine(item)}`)]
      : []),
    `${text.where}: ${oneLine(submission.where)}`,
    `${text.forWhom}: ${oneLine(submission.forWhom)}`,
    submission.when ? `${text.when}: ${oneLine(submission.when)}` : undefined,
    submission.amount
      ? `${text.amount}: ${oneLine(submission.amount)}`
      : undefined,
    `${text.personalData}: ${submission.personalData.length > 0 ? submission.personalData.map(oneLine).join(", ") : "—"}`,
    paymentLine(call, text),
    call.site ? `${text.site}: ${oneLine(call.site)}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
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
    return [
      text.permissionRevoke,
      call.kind === undefined && site === undefined
        ? "—"
        : describeStandingActionIn(language, rule),
    ].join("\n");
  }
  return [
    text.permissionSet,
    describeStandingActionIn(language, rule),
    text.permissionFooter,
  ].join("\n");
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
  const scope = [merchant, category === null ? null : `«${category}»`]
    .filter((part) => part !== null)
    .join(", ");
  if (call.action === "set" && call.limitRub !== undefined) {
    return [
      text.limitSet,
      describeSpendRuleIn(language, {
        category,
        limitRub: call.limitRub,
        merchant,
      }),
    ].join("\n");
  }
  if (call.action === "include") {
    return [text.limitChange, `${text.limitInclude}: ${scope || "—"}`].join(
      "\n"
    );
  }
  if (call.action === "clear") {
    return [text.limitChange, `${text.limitClear}: ${scope || "—"}`].join("\n");
  }
  return text.limitChange;
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
  return [
    text.notionTask,
    `«${oneLine(call.title)}»`,
    call.due ? `${text.notionDue}: ${oneLine(call.due)}` : undefined,
    call.database
      ? `${text.notionDatabase}: ${oneLine(call.database)}`
      : undefined,
    call.notes ? `${text.notionNotes}: ${oneLine(call.notes)}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

const slackMessageCallSchema = z.object({ text: z.string(), to: z.string() });

/** The card for a Slack message: who gets it and exactly what it says. */
function slackMessagePrompt(
  call: z.infer<typeof slackMessageCallSchema>,
  text: CardText
) {
  return [
    text.slackMessage,
    `${text.slackTo}: ${oneLine(call.to)}`,
    `${text.slackText}: ${oneLine(call.text)}`,
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
 * The email's text as the card quotes it: line by line under a rule, so no
 * line of the text can pass for a field of the card («Кому: …»), and cut
 * with a note of how much is left when it is longer than a card holds.
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
  const quoted = shown
    .split("\n")
    .map((line) => `│ ${oneLine(line)}`.trimEnd());
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
  const subject = call.subject ? oneLine(call.subject) : undefined;
  let topic: string | undefined;
  if (call.replyToMessageId !== undefined) {
    topic = subject
      ? `${text.emailReply}: «${subject}»`
      : text.emailReplyUnnamed;
  } else if (subject) {
    topic = `${text.emailSubject}: ${subject}`;
  }
  return [
    draft ? text.emailDraft : text.emailSend,
    `${text.emailTo}: ${list(call.to)}`,
    call.cc.length > 0 ? `${text.emailCc}: ${list(call.cc)}` : undefined,
    call.bcc.length > 0 ? `${text.emailBcc}: ${list(call.bcc)}` : undefined,
    topic,
    `${text.emailBody}:`,
    ...quotedBody(call.body, text),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
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

/**
 * When an event happens, on the clock its times were written in: the
 * weekday and date, the hours, and the zone — «чт, 1 окт., 14:30–15:00
 * (Europe/Moscow, UTC+3)». The card shows the times exactly as the call
 * carries them, never converted, so it cannot drift from what Google gets.
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
  const format = new Intl.DateTimeFormat(
    language === "ru" ? "ru-RU" : "en-US",
    {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
      weekday: "short",
    }
  );
  const span =
    from.date === to.date
      ? `${format.format(from.day)}, ${from.time}–${to.time}`
      : `${format.format(from.day)}, ${from.time} – ${format.format(to.day)}, ${to.time}`;
  const named =
    timeZone && !/^(?:utc|etc\/utc|gmt)$/iu.test(timeZone.trim())
      ? `${oneLine(timeZone)}, `
      : "";
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
  return [
    text.calendarCreate,
    `«${oneLine(call.summary)}»`,
    `${text.when}: ${eventWhen(call.start, call.end, call.timezone, language)}`,
    call.location ? `${text.where}: ${oneLine(call.location)}` : undefined,
    call.attendees.length > 0
      ? `${text.calendarGuests}: ${call.attendees.map(oneLine).join(", ")}`
      : undefined,
    call.description
      ? `${text.calendarNotes}: ${notesLine(call.description)}`
      : undefined,
    call.attendees.length > 0 ? text.calendarInvitation : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

const calendarUpdateCallSchema = z.object({
  description: z.string().optional(),
  end: z.string().optional(),
  eventTitle: z.string().optional(),
  location: z.string().optional(),
  start: z.string().optional(),
  summary: z.string().optional(),
  timezone: z.string().optional(),
});

/** The event a change names, or none for a call parked before titles. */
function eventName(title: string | undefined) {
  return title ? ` «${oneLine(title)}»` : "";
}

/** The card for moving or changing an event: which one, and what changes. */
function calendarUpdatePrompt(
  call: z.infer<typeof calendarUpdateCallSchema>,
  text: CardText,
  language: CardLanguage
) {
  return [
    `${text.calendarUpdate}${eventName(call.eventTitle)}:`,
    call.start !== undefined && call.end !== undefined
      ? `${text.calendarNewTime}: ${eventWhen(call.start, call.end, call.timezone, language)}`
      : undefined,
    call.summary
      ? `${text.calendarNewTitle}: «${oneLine(call.summary)}»`
      : undefined,
    call.location ? `${text.where}: ${oneLine(call.location)}` : undefined,
    call.description
      ? `${text.calendarNotes}: ${notesLine(call.description)}`
      : undefined,
    text.calendarUpdateFooter,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/**
 * Longest card text a channel shows whole: Telegram cuts an approval card
 * at 4,000 characters, so a card that would run longer is not shown at all
 * and the call is refused instead (`appsCardFits`).
 */
const approvalCardMaxLength = 3_500;

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
  return [
    text.title,
    `${text.app}: ${appName(call.app)}`,
    call.summary ? `${text.appAction}: ${oneLine(call.summary)}` : undefined,
    `${text.appTool}: ${oneLine(call.tool)}`,
    `${text.appArguments}:`,
    ...argumentLines(call.arguments),
  ]
    .filter((line) => line !== undefined)
    .join("\n");
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
    return `${text.notionSearch} ${query ? `«${oneLine(query)}»` : text.notionRecent}`;
  }
  if (action.toolName === "notion-read") {
    const call = z.object({ id: z.string() }).safeParse(action.input);
    return call.success
      ? `${text.notionRead} ${oneLine(call.data.id)}`
      : undefined;
  }
  if (action.toolName === "slack-read") {
    const call = z
      .object({ from: z.string(), threadTs: z.string().optional() })
      .safeParse(action.input);
    if (!call.success) return undefined;
    const thread = call.data.threadTs
      ? ` (${text.slackThread} ${oneLine(call.data.threadTs)})`
      : "";
    return `${text.slackRead} ${oneLine(call.data.from)}${thread}`;
  }
  if (action.toolName === "slack-search") {
    const call = z.object({ query: z.string() }).safeParse(action.input);
    return call.success
      ? `${text.slackSearch} «${oneLine(call.data.query)}»`
      : undefined;
  }
  return undefined;
}

const scheduleCallSchema = z.object({
  prompt: z.string().optional(),
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
  return [
    created ? text.scheduleCreate : text.scheduleUpdate,
    call.prompt === undefined
      ? undefined
      : `${text.what}: ${oneLine(call.prompt)}`,
    call.timing === undefined
      ? undefined
      : `${text.when}: ${scheduleWhen(call.timing)}`,
    call.status === undefined
      ? undefined
      : `${text.scheduleStatus}: ${text.scheduleStatuses[call.status]}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
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
      .object({ eventTitle: z.string().optional() })
      .safeParse(action.input);
    return call.success
      ? `${text.calendarDelete}${eventName(call.data.eventTitle)}.\n${text.calendarDeleteFooter}`
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
      ? `${text.memoryForget}\n«${oneLine(call.data.text)}»`
      : undefined;
  }
  // The saved work by the title its policy checked against the record; a
  // call parked before titles were passed is named by its id.
  if (action.toolName === "workstreams__forget") {
    const call = z
      .object({ id: z.string(), title: z.string().optional() })
      .safeParse(action.input);
    return call.success
      ? `${text.workstreamForget} «${oneLine(call.data.title ?? call.data.id)}»`
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
