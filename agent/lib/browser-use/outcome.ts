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
