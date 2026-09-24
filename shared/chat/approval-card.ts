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
    cancel: "Cancel",
    card: "Pays with the saved card",
    cardUpTo: "Pays with the saved card, up to",
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
    notionTask: "Add a task to Notion:",
    permissionFooter:
      "It holds in the conversation until it is taken back; each errand stays on its own site, and background work never uses it.",
    permissionRevoke: "Take back the standing permission:",
    permissionSet:
      "Standing permission — such errands go ahead without asking from now on:",
    personalData: "Details sent",
    site: "Site",
    slackMessage: "Send a Slack message:",
    slackText: "Text",
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
    cancel: "Отмена",
    card: "Оплата сохранённой картой",
    cardUpTo: "Оплата сохранённой картой, не больше",
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
    notionTask: "Добавить задачу в Notion:",
    permissionFooter:
      "Действует в разговоре, пока его не снимут; каждое поручение остаётся на своём сайте, фоновая работа им не пользуется.",
    permissionRevoke: "Снять постоянное разрешение:",
    permissionSet:
      "Постоянное разрешение — такие поручения дальше без подтверждения:",
    personalData: "Какие данные уйдут",
    site: "Сайт",
    slackMessage: "Отправить сообщение в Slack:",
    slackText: "Текст",
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
    call.notes
      ? `${text.notionNotes}: ${clipped(oneLine(call.notes))}`
      : undefined,
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

/** Longest value a card line shows; the rest is cut with an ellipsis. */
const cardValueLength = 200;

function clipped(value: string) {
  return value.length > cardValueLength
    ? `${value.slice(0, cardValueLength)}…`
    : value;
}

/** Argument lines one `apps` card lists before cutting the rest. */
const cardArgumentLines = 12;

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

/** One argument line of an `apps` card: the name and the value as JSON. */
function argumentLines(argumentsJson: string | undefined) {
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson ?? "{}");
  } catch {
    return [clipped(oneLine(argumentsJson ?? ""))];
  }
  const entries = Object.entries(
    z.record(z.string(), z.json()).safeParse(value).data ?? {}
  );
  const lines = entries
    .slice(0, cardArgumentLines)
    .map(
      ([name, item]) =>
        `  ${oneLine(name)}: ${clipped(oneLine(z.string().safeParse(item).data ?? JSON.stringify(item)))}`
    );
  return entries.length > cardArgumentLines ? [...lines, "  …"] : lines;
}

/**
 * The card for an `apps` call that writes: which app, what the call does in
 * the model's own words, the exact tool, and every argument it sends, so
 * the words cannot promise less than the call does.
 */
function appsPrompt(call: z.infer<typeof appsCallSchema>, text: CardText) {
  return [
    text.title,
    `${text.app}: ${appName(call.app)}`,
    call.summary
      ? `${text.appAction}: ${clipped(oneLine(call.summary))}`
      : undefined,
    `${text.appTool}: ${oneLine(call.tool)}`,
    `${text.appArguments}:`,
    ...argumentLines(call.arguments),
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
