import { z } from "zod";

const errorObjectSchema = z
  .object({
    code: z.union([z.number(), z.string()]).nullish(),
    message: z.string().optional(),
  })
  .loose();

/** An error as RouterAI reports it, once read out of any text it was in. */
type ReportedError = z.infer<typeof errorObjectSchema>;

/**
 * An error as RouterAI reports it: an object, or a text that is often the
 * upstream's whole JSON answer (`{"error":{"code":402,"message":…}}`), whose
 * `code` is the real status, often under HTTP 200 (probes of 01.10). Such a
 * text is read in turn; any other text becomes the message.
 */
export const reportedErrorSchema: z.ZodType<ReportedError> = z.union([
  errorObjectSchema,
  z.string().transform((text) => errorInsideText(text) ?? { message: text }),
]);

/** The error a text holds when the text is a whole JSON answer. */
function errorInsideText(text: string) {
  try {
    return z
      .object({ error: z.lazy(() => reportedErrorSchema) })
      .safeParse(JSON.parse(text)).data?.error;
  } catch {
    return undefined;
  }
}

const failureStatusSchema = z.coerce.number().int().min(400).max(599);

/** The HTTP failure status an error's code names, if it names one. */
export function failureStatus(code: ReportedError["code"]) {
  return code === null || code === undefined
    ? undefined
    : failureStatusSchema.safeParse(code).data;
}
