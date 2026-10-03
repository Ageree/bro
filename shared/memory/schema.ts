import { z } from "zod";

// A rule is a boundary the person set for Bro («без моего ок ничего не
// оплачивай», «никогда не пиши маме»): recall shows it first, as something
// that only restricts.
const memoryCategorySchema = z.enum([
  "fact",
  "preference",
  "person",
  "organization",
  "decision",
  "rule",
]);

export const memoryIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(2 ** 53 - 1);

/**
 * A number a code is: 3–12 digits, maybe split as «123-456» or «55 12 98»,
 * and not a year («с 2023 года»).
 */
const codeDigits = String.raw`(\d(?:[ -]?\d){2,11})(?!\d)(?!\s*(?:год|г\.))`;
const notAfterWord = String.raw`(?<![\p{L}\d])`;
const notBeforeLetter = String.raw`(?!\p{L})`;
/** What may stand between a code's name and its number: «PIN-код карты: 1234». */
const codeGap = String.raw`(?:\s*(?:[:=#№—–-]|(?:код|code|карты|card|is|это)${notBeforeLetter}))*\s*`;

/**
 * What a credential or a one-time code looks like in a memory, in English
 * and in Russian: «api_key = …», a provider token, a card number, «пароль от
 * почты — Kot2024!», «PIN 1234», «смс 482193». The first group of each is
 * the secret itself, which the digest cuts out of a longer text.
 */
const credentialPatterns = [
  /\b(?:api[_ -]?key|access[_ -]?token|password|passwd|secret|private[_ -]?key|otp|one[_ -]?time[_ -]?code)\b\s*[:=]\s*(\S+)/dgiu,
  /\b[a-z][a-z0-9_]*(?:secret|token|api_key|password)[a-z0-9_]*\s*[:=]\s*(\S+)/dgiu,
  /\b((?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,})\b/dgu,
  /\bbearer\s+([A-Za-z0-9._~+/-]{20,}=*)/dgiu,
  // A Telegram bot's token.
  /\b(\d{8,10}:[A-Za-z0-9_-]{30,})/dgu,
  /((?:\d[ -]?){13,19})/dgu,
  // A password said with its value: after «:», «=» or a dash, a value with
  // a digit, a Latin letter or a sign in it («пароль от почты — Kot2024!»),
  // or one word that ends the clause or that a qualifier follows («пароль:
  // Мурзик», «пароль: Мурзик для сайта» — not «пароль — на наклейке
  // роутера»); or right after the word, a value with a digit
  // («пароль от wifi qwerty123»).
  new RegExp(
    String.raw`${notAfterWord}(?:парол\p{L}*|password|passwd|passcode|pwd)${notBeforeLetter}(?:[^\n:=—–]{0,40}?(?:[:=]|\s[—–-]\s)\s*[«"']?((?=[^\s«»"']*[\dA-Za-z!@#$%^&*_])[^\s«»"']+|[^\s«»"',.;:()]+(?=[«»"']?\s*(?:$|[,.;)])|\s+(?:для|от|на|к|в|из|с|for|to|on|at)\s))|\s+(?:(?:от|для|к|на|for|to)\s+\S+\s+)?(?:это\s+|is\s+)?[«"']?([^\s«»"']*\d[^\s«»"']*))`,
    "dgiu"
  ),
  // A card's or an app's secret number is one whatever surrounds it.
  new RegExp(
    String.raw`${notAfterWord}(?:otp|totp|2fa|cvv2?|cvc2?|пин-?код|pin-?code|пин|pin)${notBeforeLetter}${codeGap}${codeDigits}`,
    "dgiu"
  ),
  // An SMS code has four digits or more: «смс 482193», «смс от банка: 1234»,
  // «смс для входа 482193»,
  // not «рейс SMS 123».
  new RegExp(
    String.raw`${notAfterWord}(?:смс|sms)${notBeforeLetter}${codeGap}(?:(?:от|из|с|для|from|for)\s+[^\s\d]+${codeGap})?(?=\d(?:[ -]?\d){3})${codeDigits}`,
    "dgiu"
  ),
];

/** «Код» with a number: a secret only beside a sign-in, an SMS or a service. */
const codeWithNumber = new RegExp(
  String.raw`${notAfterWord}(?:код\p{L}{0,3}|code|kod)${notBeforeLetter}([^\d]{0,50}?)${codeDigits}`,
  "dgiu"
);
/** What makes a code one-time, near it on either side. */
const oneTimeWords =
  /(?:смс|sms|подтвержд|проверочн|верифик|одноразов|авториз|логин|login|sign[- ]?in|verif|confirm|one[- ]?time|двухфактор|two[- ]?factor|2fa|восстановлен|recovery|backup)/iu;
/** A sign-in or a service the code belongs to, named in its clause. */
const codeOwners =
  /(?:вход|госуслуг|gosuslug|есиа|банк|bank|сбер|тинькоф|ozon|озон|wildberries|telegram|телеграм|whatsapp|вотсап|почт|e-?mail|apple|google|гугл|яндекс|yandex|вконтакте|(?<!\p{L})vk(?!\p{L})|авито|avito|push|пуш)/iu;
/** A door's code is no one-time code («код домофона 1234К, вход со двора»). */
const doorWords =
  /(?:домофон|подъезд|калитк|ворот|двер|шлагбаум|этаж|сейф|замк|замок|ячейк|intercom|door|gate|entrance)/iu;
const codeContextChars = 25;

/** The first group a match captured, as a `[start, end)` range. */
function capturedRange(match: RegExpExecArray) {
  const groups = match.indices?.slice(1) ?? [];
  const range = groups.find((group) => group !== undefined);
  return range ?? ([match.index, match.index + match[0].length] as const);
}

/**
 * Where a text carries a credential or a one-time code, as `[start, end)`
 * ranges of the secret itself; none for a text memory may keep.
 */
export function unsafeMemoryRanges(value: string) {
  const ranges = credentialPatterns.flatMap((pattern) =>
    [...value.matchAll(pattern)].map(capturedRange)
  );
  for (const match of value.matchAll(codeWithNumber)) {
    const gap = match[1] ?? "";
    // The words before «код» in its own clause: «код домофона 1234, код
    // Ozon 5678» has a door code and an Ozon one.
    const before =
      value
        .slice(Math.max(0, match.index - codeContextChars), match.index)
        .split(/[,;.!?\n]/u)
        .at(-1) ?? "";
    if (doorWords.test(gap) || doorWords.test(before)) continue;
    const end = match.index + match[0].length;
    const around = before + match[0] + value.slice(end, end + codeContextChars);
    // A service names its code before «код» as well: «в Ozon код 1234».
    if (
      oneTimeWords.test(around) ||
      codeOwners.test(gap) ||
      codeOwners.test(before)
    ) {
      const digits = match.indices?.[2];
      ranges.push(digits ?? [match.index, end]);
    }
  }
  return ranges;
}

export function isSafeMemoryText(value: string) {
  return unsafeMemoryRanges(value).length === 0;
}

/**
 * A memory's text as a confirmation card compares it: a call that names the
 * record with other quotes, case or spacing still names the same record.
 */
export function comparableMemoryText(text: string) {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll(/[«»"“”„]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

/** A memory's text as it is kept: one line, safe, at most 2 KB. */
export const memoryTextSchema = z
  .string()
  .trim()
  .transform((value) => value.replaceAll(/\s+/gu, " "))
  .pipe(
    z
      .string()
      .min(1)
      .max(2_048)
      .refine(
        isSafeMemoryText,
        "Credentials, payment data, private keys, tokens, and one-time codes cannot be saved in memory."
      )
  );

const memoryAliasSchema = z
  .string()
  .trim()
  .transform((value) => value.replaceAll(/\s+/gu, " "))
  .pipe(z.string().min(1).max(80).refine(isSafeMemoryText, "Unsafe alias"));

export const memoryContentSchema = z.strictObject({
  text: memoryTextSchema,
  category: memoryCategorySchema
    .default("fact")
    .describe(
      "rule: a boundary the user set for you in their own message — what you never do, or never without their OK («без моего ок ничего не оплачивай», «никогда не пиши маме», «не трогай рабочую почту»)."
    ),
  aliases: z.array(memoryAliasSchema).max(12).default([]),
  relatedIndexes: z.array(memoryIndexSchema).max(12).default([]),
  validUntil: z.iso.datetime({ offset: true }).nullable().default(null),
  localOnly: z.boolean().default(false),
});

export type MemoryContent = z.infer<typeof memoryContentSchema>;

export const saveMemorySchema = memoryContentSchema.extend({});

export const updateMemorySchema = z.strictObject({
  index: memoryIndexSchema,
  expectedRevision: z.number().int().positive(),
  content: memoryContentSchema,
});

export const forgetMemorySchema = z.strictObject({
  index: memoryIndexSchema,
  expectedRevision: z.number().int().positive().optional(),
});

export const findMemorySchema = z.strictObject({
  query: z.string().trim().max(200).default(""),
  category: memoryCategorySchema.optional(),
  offset: z.number().int().min(0).max(1_000).default(0),
});
