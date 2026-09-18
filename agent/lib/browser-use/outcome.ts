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

// «нет» / "none" / "-" all mean "nothing in this field".
const emptyValue = /^(?:none|нет|-|—|n\/a|н\/д)$/iu;

/**
 * A model asked for labelled lines in prose still decorates them: a leading
 * bullet, or Markdown bold around the label and sometimes the value. Missing
 * the label costs the parse the whole block, so both are tolerated.
 */
function rawLabelledValue(text: string, label: string) {
  const pattern = new RegExp(
    `^[ \\t]*(?:[-*•]+[ \\t]*)?\\*{0,2}${label}\\*{0,2}[ \\t]*:[ \\t]*(.+)$`,
    "imu"
  );
  return text
    .match(pattern)?.[1]
    ?.replaceAll(/^\*+|[\s*]+$/gu, "")
    .trim();
}

/** The label was written, but «нет» / "none" / "-" means it carries nothing. */
function labelledValue(text: string, label: string) {
  const value = rawLabelledValue(text, label);
  if (!value || emptyValue.test(value)) return undefined;
  return value;
}

export function parseBrowserOutcome(result: string | null | undefined) {
  const text = (result ?? "").trim();
  const rawNeeds = rawLabelledValue(text, "NEEDS");
  const candidate = rawNeeds?.toLowerCase().replaceAll(/\s+/gu, "_");
  return {
    details: labelledValue(text, "DETAILS"),
    labelled: rawNeeds !== undefined,
    needs: browserRunNeeds.find((need) => need === candidate) ?? "none",
    order: labelledValue(text, "ORDER"),
    result: labelledValue(text, "RESULT"),
    total: labelledValue(text, "TOTAL"),
  };
}

/** One compact line per fact, for the coordinator's own reading. */
export function browserOutcomeSummary(
  outcome: ReturnType<typeof parseBrowserOutcome>,
  fallback: string
) {
  const lines = [
    outcome.result ? `Result: ${outcome.result}` : fallback,
    outcome.order ? `Order: ${outcome.order}` : undefined,
    outcome.total ? `Total: ${outcome.total}` : undefined,
    outcome.needs === "none" ? undefined : `Needs: ${outcome.needs}`,
    outcome.details ? `Details: ${outcome.details}` : undefined,
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
  if (outcome.needs !== "none") return null;
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
