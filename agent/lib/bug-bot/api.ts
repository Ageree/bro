import { z } from "zod";

const telegramApiBaseUrl = "https://api.telegram.org";
const requestTimeoutMs = 10_000;

const envelopeSchema = z.object({
  description: z.string().optional(),
  error_code: z.number().optional(),
  ok: z.boolean(),
  result: z.json().optional(),
});

/**
 * One Bot API call. The reply is read through the envelope and then through
 * `result`'s own schema; a refusal, a bad body or a network failure is a
 * `failed` outcome with the HTTP status or Telegram's `error_code`, never the
 * request (its URL holds the token).
 */
export async function callBotApi<Schema extends z.ZodType>(
  botToken: string,
  method: string,
  parameters: Readonly<Record<string, boolean | number | string | string[]>>,
  result: Schema,
  timeoutMs = requestTimeoutMs
): Promise<
  | { readonly ok: true; readonly result: z.output<Schema> }
  | { readonly code: number; readonly ok: false }
> {
  try {
    const response = await fetch(
      `${telegramApiBaseUrl}/bot${botToken}/${method}`,
      {
        body: JSON.stringify(parameters),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
    const envelope = envelopeSchema.safeParse(
      await response.json().catch(() => undefined)
    );
    if (!envelope.success) return { code: response.status, ok: false };
    const parsed = result.safeParse(envelope.data.result);
    if (!envelope.data.ok || !parsed.success) {
      return { code: envelope.data.error_code ?? response.status, ok: false };
    }
    return { ok: true, result: parsed.data };
  } catch {
    return { code: 0, ok: false };
  }
}

const userSchema = z.object({
  first_name: z.string().optional(),
  id: z.number(),
  is_bot: z.boolean().optional(),
  username: z.string().optional(),
});

const messageSchema = z.object({
  caption: z.string().optional(),
  chat: z.object({ id: z.number(), type: z.string() }),
  date: z.number().optional(),
  from: userSchema.optional(),
  message_id: z.number(),
  photo: z.array(z.object({ file_id: z.string() })).optional(),
  reply_to_message: z.object({ message_id: z.number() }).optional(),
  text: z.string().optional(),
});

export const updatesSchema = z.array(
  z.object({ message: messageSchema.optional(), update_id: z.number() })
);

export const sentMessageSchema = z.object({ message_id: z.number() });

export type BugBotMessage = z.output<typeof messageSchema>;
export type BugBotUpdate = z.output<typeof updatesSchema>[number];
