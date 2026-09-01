import { z } from "zod";

const detectedAutofillFieldSchema = z.object({
  score: z.number().min(0).max(100),
  token: z.string().trim().min(1).max(80),
});

const detectedAutofillSurfaceSchema = z.object({
  fields: z.array(detectedAutofillFieldSchema).min(1).max(40),
  id: z.string().trim().min(1).max(120),
  kind: z.string().trim().min(1).max(80),
});

const autofillClaimSchema = z.object({
  id: z.uuid(),
  token: z.string().trim().min(1).max(80),
  value: z.string().min(1).max(20_000),
});

export type AutofillClaim = z.infer<typeof autofillClaimSchema>;
export type DetectedAutofillSurface = z.infer<typeof detectedAutofillSurfaceSchema>;
