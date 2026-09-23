import { z } from "zod";

const checkIdSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u);

export const browserVerificationDateSchema = z.iso.date();

const partialDateSchema = z
  .string()
  .regex(/^--(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u)
  .refine(
    (value) =>
      browserVerificationDateSchema.safeParse(`2000-${value.slice(2)}`).success
  );

const predicateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text_present") }).strict(),
  z
    .object({
      caseSensitive: z.boolean().default(false),
      expected: z.string().min(1).max(240),
      kind: z.literal("text_exact"),
    })
    .strict(),
  z
    .object({
      caseSensitive: z.boolean().default(false),
      expected: z.string().min(1).max(240),
      kind: z.literal("text_contains"),
    })
    .strict(),
  z
    .object({
      caseSensitive: z.boolean().default(false),
      expected: z.string().min(1).max(240),
      kind: z.literal("text_absent"),
    })
    .strict(),
  z
    .object({
      currency: z.enum(["EUR", "GBP", "RUB", "USD"]).optional(),
      decimalSeparator: z.enum([",", "."]),
      kind: z.literal("number"),
      maximum: z.number().optional(),
      minimum: z.number().optional(),
      numberWords: z.enum(["en", "ru"]).optional(),
    })
    .strict()
    .refine(
      ({ maximum, minimum }) => maximum !== undefined || minimum !== undefined,
      { message: "A numeric check needs a minimum or maximum." }
    )
    .refine(
      ({ maximum, minimum }) =>
        maximum === undefined || minimum === undefined || minimum <= maximum,
      { message: "A numeric minimum cannot exceed its maximum." }
    ),
  z
    .object({
      expected: z
        .union([browserVerificationDateSchema, partialDateSchema])
        .optional(),
      kind: z.literal("date"),
      maximum: browserVerificationDateSchema.optional(),
      minimum: browserVerificationDateSchema.optional(),
    })
    .strict()
    .superRefine(({ expected, maximum, minimum }, context) => {
      if (
        expected === undefined &&
        maximum === undefined &&
        minimum === undefined
      )
        context.addIssue({
          code: "custom",
          message: "A date check needs an expected date or a boundary.",
        });
      if (
        expected !== undefined &&
        (maximum !== undefined || minimum !== undefined)
      )
        context.addIssue({
          code: "custom",
          message: "An expected date cannot be combined with date boundaries.",
        });
      if (minimum !== undefined && maximum !== undefined && minimum > maximum)
        context.addIssue({
          code: "custom",
          message: "A date minimum cannot exceed its maximum.",
        });
    }),
]);

const verificationCheckSchema = z
  .object({
    description: z.string().min(1).max(240),
    groupId: checkIdSchema.optional(),
    id: checkIdSchema,
    mandatory: z.boolean().default(true),
    predicate: predicateSchema,
    purpose: z.enum(["identity", "order_reference", "order_total"]).optional(),
  })
  .strict()
  .superRefine((check, context) => {
    if (
      check.purpose === "identity" &&
      check.predicate.kind !== "text_present" &&
      check.predicate.kind !== "text_exact" &&
      check.predicate.kind !== "text_contains"
    ) {
      context.addIssue({
        code: "custom",
        message: "An identity purpose needs a positive text predicate.",
        path: ["predicate"],
      });
    }
    if (
      check.purpose === "order_reference" &&
      check.predicate.kind !== "text_exact" &&
      check.predicate.kind !== "text_contains"
    ) {
      context.addIssue({
        code: "custom",
        message: "An order reference purpose needs a positive text predicate.",
        path: ["predicate"],
      });
    }
    if (
      check.purpose === "order_total" &&
      (check.predicate.kind !== "number" || check.predicate.currency !== "RUB")
    ) {
      context.addIssue({
        code: "custom",
        message: "An order total purpose needs a RUB numeric predicate.",
        path: ["predicate"],
      });
    }
  });

export const browserVerificationPlanSchema = z
  .object({
    checks: z.array(verificationCheckSchema).min(1).max(16),
    version: z.literal(1),
  })
  .strict()
  .superRefine(({ checks }, context) => {
    const ids = new Set<string>();
    for (const [index, check] of checks.entries()) {
      if (ids.has(check.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate check id: ${check.id}`,
          path: ["checks", index, "id"],
        });
      }
      ids.add(check.id);
    }
    if (!checks.some((check) => check.mandatory)) {
      context.addIssue({
        code: "custom",
        message: "A verification plan needs at least one mandatory check.",
        path: ["checks"],
      });
    }
  });

const evidenceLocatorSchema = z
  .object({
    checkId: checkIdSchema,
    pageUrl: z
      .url()
      .max(2_048)
      .refine((value) => /^https?:\/\//u.test(value), {
        message: "Evidence must refer to an HTTP page.",
      })
      .refine((value) => {
        const url = new URL(value);
        return !url.username && !url.password;
      }, "Evidence page URLs cannot contain credentials."),
    scopeSelector: z.string().min(1).max(500),
    selector: z.string().min(1).max(500),
  })
  .strict();

export const browserVerificationProofSchema = z
  .object({
    checks: z.array(evidenceLocatorSchema).min(1).max(16),
    version: z.literal(1),
  })
  .strict();

const observedCheckSchema = z.object({
  checkId: checkIdSchema,
  observation: z.string().max(240).optional(),
  observedAt: z.iso.datetime(),
  pageUrl: z.url().max(2_048),
  status: z.enum(["passed", "failed", "unverified"]),
  value: z.union([z.number(), browserVerificationDateSchema]).optional(),
});

const verificationDefectSchema = z.object({
  checkId: checkIdSchema.optional(),
  code: z.enum([
    "acceptance_failed",
    "ambiguous_match",
    "duplicate_evidence",
    "group_mismatch",
    "invalid_evidence",
    "javascript_error",
    "missing_evidence",
    "page_missing",
    "sensitive_evidence",
    "timeout",
    "unavailable",
  ]),
  message: z.string().min(1).max(240),
});

export const browserVerificationReportSchema = z.object({
  defects: z.array(verificationDefectSchema).max(32),
  elapsedMs: z.number().int().nonnegative(),
  observedChecks: z.array(observedCheckSchema).max(16),
  verdict: z.enum(["verified", "failed", "unverified"]),
});

export type BrowserVerificationPlan = z.infer<
  typeof browserVerificationPlanSchema
>;
export type BrowserVerificationProof = z.infer<
  typeof browserVerificationProofSchema
>;
export type BrowserVerificationReport = z.infer<
  typeof browserVerificationReportSchema
>;
