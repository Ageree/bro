/**
 * The labelled block every run is asked to finish with, turned into one record
 * the coordinator can speak from. The labels are fixed English keys; their
 * values stay in the language the errand was written in.
 */
export const browserRunNeeds = [
  "none",
  "sms_code",
  "email_code",
  "push",
  "3ds",
  "captcha",
  "password",
  "address",
  "payment",
  "decision",
  "info",
] as const;

export type BrowserRunNeed = (typeof browserRunNeeds)[number];

const browserOutcomeStatuses = ["complete", "partial", "blocked"] as const;

export type BrowserOutcomeStatus =
  | (typeof browserOutcomeStatuses)[number]
  | "invalid";

// «нет» / "none" / "-" all mean "nothing in this field".
const emptyValue = /^(?:none|нет|-|—|n\/a|н\/д)$/iu;

/**
 * A model asked for labelled lines in prose still decorates them: a leading
 * bullet, or Markdown bold around the label and sometimes the value. Missing
 * the label costs the parse the whole block, so both are tolerated.
 */
const outcomeLabels = [
  "REPORT",
  "STATUS",
  "RESULT",
  "EVIDENCE",
  "ORDER",
  "TOTAL",
  "NEEDS",
  "DETAILS",
  "NEXT",
  "CHECKS",
] as const;

type OutcomeLabel = (typeof outcomeLabels)[number];

const labelledLine = new RegExp(
  `^[ \\t]*(?:[-*•]+[ \\t]*)?\\*{0,2}(${outcomeLabels.join("|")})\\*{0,2}[ \\t]*:\\*{0,2}[ \\t]*(.*)$`,
  "iu"
);

const sensitiveUrlKeys =
  /(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth(?:orization)?|code|key|secret|session(?:id)?|sig(?:nature)?|token)(?:$|[_-])/iu;

function sanitizeUrl(value: string) {
  try {
    const url = new URL(value);
    if (/^(?:live\.|live-|.*browser-use)/iu.test(url.hostname)) {
      return "[redacted live-view URL]";
    }
    url.username = "";
    url.password = "";
    for (const key of url.searchParams.keys()) {
      if (sensitiveUrlKeys.test(key)) url.searchParams.set(key, "[redacted]");
    }
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function sanitizeBrowserOutput(value: string, limit = 4_000) {
  const urls: string[] = [];
  const withoutUrls = value.replaceAll(/https?:\/\/[^\s<>"']+/giu, (url) => {
    const index = urls.push(sanitizeUrl(url)) - 1;
    return `\uE000${String(index)}\uE001`;
  });
  return withoutUrls
    .replaceAll(/<[^>]*>/gu, " ")
    .replaceAll(
      /---\s*(?:begin|end)\s+untrusted browser data\s*---/giu,
      "[browser data marker removed]"
    )
    .replaceAll(
      /\b(?:authorization\s*:\s*)?bearer\s+[^\s]+/giu,
      "[redacted credential]"
    )
    .replaceAll(
      /(^|[^\p{L}\p{N}_])(?:password|passcode|otp|one[- ]time code|sms code|token|пароль|код(?:[ \t]+из[ \t]+смс)?)[ \t]*[:=]?[ \t]*(?:\d{4,8}|\S{6,})/gimu,
      "$1[redacted credential]"
    )
    .replaceAll(
      /\uE000(\d+)\uE001/gu,
      (_placeholder, index: string) => urls[Number(index)] ?? "[redacted URL]"
    )
    .replaceAll(/\p{Cc}/gu, (character) =>
      ["\n", "\r", "\t"].includes(character) ? character : ""
    )
    .replaceAll(/[ \t]+\n/gu, "\n")
    .trim()
    .slice(0, limit);
}

function labelledValues(text: string) {
  const values = new Map<OutcomeLabel, string[]>();
  let current: OutcomeLabel | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const match = labelledLine.exec(line);
    if (match) {
      current = outcomeLabels.find(
        (label) => label === match[1]?.toUpperCase()
      );
      if (current === undefined) continue;
      if (!values.has(current)) values.set(current, []);
      values.get(current)?.push(match[2] ?? "");
      continue;
    }
    if (current !== undefined) values.get(current)?.push(line);
  }
  return values;
}

function rawLabelledValue(
  values: Map<OutcomeLabel, string[]>,
  label: OutcomeLabel
) {
  const value = values.get(label)?.join("\n");
  if (value === undefined) return undefined;
  return sanitizeBrowserOutput(value.replaceAll(/^\*+|[\s*]+$/gu, ""));
}

/** The label was written, but «нет» / "none" / "-" means it carries nothing. */
function labelledValue(
  values: Map<OutcomeLabel, string[]>,
  label: OutcomeLabel
) {
  const value = rawLabelledValue(values, label);
  if (!value || emptyValue.test(value)) return undefined;
  return value;
}

function outcomePreamble(text: string) {
  const lines = text.split(/\r?\n/u);
  const firstLabel = lines.findIndex((line) => labelledLine.test(line));
  if (firstLabel === 0) return undefined;
  const preamble = sanitizeBrowserOutput(
    firstLabel === -1 ? text : lines.slice(0, firstLabel).join("\n")
  );
  return preamble || undefined;
}

export function parseBrowserOutcome(result: string | null | undefined) {
  const text = (result ?? "").trim();
  const values = labelledValues(text);
  const rawNeeds = rawLabelledValue(values, "NEEDS");
  const candidate = rawNeeds?.toLowerCase().replaceAll(/\s+/gu, "_");
  const need = browserRunNeeds.find((item) => item === candidate);
  const rawStatus = rawLabelledValue(values, "STATUS")?.toLowerCase();
  const status: BrowserOutcomeStatus | undefined = values.has("STATUS")
    ? (browserOutcomeStatuses.find((item) => item === rawStatus) ?? "invalid")
    : undefined;
  const parsedResult = labelledValue(values, "RESULT");
  const report = labelledValue(values, "REPORT") ?? outcomePreamble(text);
  return {
    details: labelledValue(values, "DETAILS"),
    evidence: labelledValue(values, "EVIDENCE"),
    labelled: rawNeeds !== undefined,
    needs: need ?? "none",
    protocolValid:
      parsedResult !== undefined && values.has("NEEDS") && need !== undefined,
    report:
      report?.replaceAll(/\s+/gu, " ").toLowerCase() ===
      parsedResult?.replaceAll(/\s+/gu, " ").toLowerCase()
        ? undefined
        : report,
    next: labelledValue(values, "NEXT"),
    order: labelledValue(values, "ORDER"),
    result: parsedResult,
    status,
    total: labelledValue(values, "TOTAL"),
  };
}

export function resolvedBrowserOutcomeStatus(
  outcome: ReturnType<typeof parseBrowserOutcome>
): BrowserOutcomeStatus {
  if (!outcome.protocolValid || outcome.status === "invalid") return "invalid";
  if (outcome.needs !== "none") return "blocked";
  return outcome.status ?? "complete";
}

/** One compact line per fact, for the coordinator's own reading. */
export function browserOutcomeSummary(
  outcome: ReturnType<typeof parseBrowserOutcome>,
  fallback: string,
  status: BrowserOutcomeStatus = resolvedBrowserOutcomeStatus(outcome)
) {
  const lines = [
    `Task status: ${status}`,
    outcome.report ? `Report: ${outcome.report}` : undefined,
    outcome.result ? `Result: ${outcome.result}` : fallback,
    outcome.evidence ? `Evidence: ${outcome.evidence}` : undefined,
    outcome.order ? `Order: ${outcome.order}` : undefined,
    outcome.total ? `Total: ${outcome.total}` : undefined,
    outcome.needs === "none" ? undefined : `Needs: ${outcome.needs}`,
    outcome.details ? `Details: ${outcome.details}` : undefined,
    outcome.next ? `Next: ${outcome.next}` : undefined,
  ];
  return lines.filter((line) => line !== undefined).join("\n");
}

type OrderStatus = "cancelled" | "placed";

const wildberriesPattern =
  /wildberries|вайлдберр|\bwb\.ru\b|(?<![\p{L}])(?:wb|вб)(?![\p{L}])/iu;
const ozonPattern = /ozon|озон/iu;
const cancelledPattern =
  /отмен(?:и|ить|ён|ен|ена|или|яю|яем)|аннулир|cancel(?:l?ed)?/iu;
const pickupPattern =
  /(?:пвз|пункт\s+выдачи|самовывоз|pickup)\s*[:\-–—]\s*(.+)/iu;
// Digits with the separators a merchant prints inside them.
const digitsOnly = /^\d[\d\s-]*$/u;

/**
 * Which shop the errand was run against. The site the run was pointed at wins:
 * a person writes «купи на вб» as often as they write the domain, but only one
 * of the two is a fact the tool recorded.
 */
export function merchantFromText(...sources: (string | null | undefined)[]) {
  for (const source of sources) {
    if (!source) continue;
    if (wildberriesPattern.test(source)) return "wb" as const;
    if (ozonPattern.test(source)) return "ozon" as const;
  }
  return "other" as const;
}

/**
 * A WB or Ozon order number is 13–19 bare digits, which is exactly a card
 * number's shape, so length cannot tell them apart. Luhn can: an order number
 * that happens to pass it is rare, a card number that fails it does not exist.
 */
function looksLikeCardNumber(value: string) {
  const bare = value.replaceAll(/[\s-]/gu, "");
  if (bare.length < 13 || bare.length > 19) return false;
  let sum = 0;
  for (let index = 0; index < bare.length; index += 1) {
    const digit = Number(bare[bare.length - 1 - index]);
    const doubled = digit * 2;
    sum += index % 2 === 0 ? digit : doubled > 9 ? doubled - 9 : doubled;
  }
  return sum % 10 === 0;
}

/** «1 299,00 ₽» and «620 руб» alike, in whole roubles. */
function priceRubFromTotal(total: string) {
  const digits = /\d[\d\s]*(?:[.,]\d{1,2})?/u.exec(total)?.[0];
  if (!digits) return undefined;
  const amount = Number.parseFloat(
    digits.replaceAll(/\s/gu, "").replace(",", ".")
  );
  return Number.isFinite(amount) && amount >= 0
    ? Math.round(amount)
    : undefined;
}

function orderTitle(
  outcome: ReturnType<typeof parseBrowserOutcome>,
  task: string
) {
  return (outcome.result ?? task).trim().split(/\r?\n/u)[0]?.slice(0, 200);
}

/**
 * The purchase a finished run made, or nothing. A run only becomes an order
 * when it reported both an order number and an amount and asked for nothing
 * further: a run parked on 3-D Secure or a missing card has not bought
 * anything yet, whatever its prose claims.
 */
export function parseBrowserOrder(
  outcome: ReturnType<typeof parseBrowserOutcome>,
  run: {
    readonly result: string | null | undefined;
    readonly site: string | null | undefined;
    readonly task: string;
  }
) {
  if (resolvedBrowserOutcomeStatus(outcome) !== "complete") return null;
  const merchantOrderId = outcome.order?.trim();
  if (!merchantOrderId || merchantOrderId.length > 64) return null;
  if (
    digitsOnly.test(merchantOrderId) &&
    looksLikeCardNumber(merchantOrderId)
  ) {
    return null;
  }
  const priceRub = outcome.total ? priceRubFromTotal(outcome.total) : undefined;
  if (priceRub === undefined) return null;
  const title = orderTitle(outcome, run.task);
  if (!title) return null;

  const pickup = pickupPattern
    .exec(run.result ?? "")?.[1]
    ?.trim()
    .slice(0, 280);
  const status: OrderStatus = cancelledPattern.test(
    `${run.task}\n${run.result ?? ""}`
  )
    ? "cancelled"
    : "placed";
  return {
    merchant: merchantFromText(run.site, run.task, run.result),
    merchantOrderId,
    pickup: pickup === undefined || pickup === "" ? null : pickup,
    priceRub,
    status,
    title,
  };
}
