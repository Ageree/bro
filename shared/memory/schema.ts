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

export function isSafeMemoryText(value: string) {
  return !(
    /\b(?:api[_ -]?key|access[_ -]?token|password|passwd|secret|private[_ -]?key|otp|one[_ -]?time[_ -]?code)\b\s*[:=]\s*\S+/iu.test(
      value
    ) ||
    /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/u.test(
      value
    ) ||
    /(?:\d[ -]?){13,19}/u.test(value)
  );
}

const safeMemoryTextSchema = z
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
  text: safeMemoryTextSchema,
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
