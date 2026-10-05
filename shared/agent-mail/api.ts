import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "@shared/environment";

const apiOrigin = "https://api.agentmail.to/v0";
const requestTimeoutMs = 20_000;
const maximumRetries = 2;
const maximumRetryDelayMs = 10_000;

const providerErrorSchema = z.object({
  code: z
    .enum([
      "missing_authorization",
      "invalid_token_type",
      "unknown_api_key",
      "api_key_expired",
      "unauthorized",
      "missing_permission",
      "permission_escalation",
      "unrestricted_key_required",
      "forbidden",
      "validation_error",
      "not_found",
      "unprocessable",
      "query_range_too_wide",
      "already_exists",
      "resource_taken",
      "limit_exceeded",
      "domain_not_verified",
      "conflict",
      "race_condition",
      "resource_deleting",
      "cannot_delete",
      "message_rejected",
      "inbox_paused",
      "rate_limit_exceeded",
      "service_unavailable",
      "internal_error",
    ])
    .optional(),
});

/** Provider failures expose only status and known codes, never email or secrets. */
class AgentMailError extends Error {
  override readonly name = "AgentMailError";

  constructor(
    readonly status: number,
    readonly code?: z.output<typeof providerErrorSchema>["code"]
  ) {
    super(
      `AgentMail request failed (${String(status)}${code ? `: ${code}` : ""}).`
    );
  }
}

const inboxSchema = z
  .object({
    inbox_id: z.string().min(1),
    email: z.email().optional(),
    display_name: z.string().optional(),
  })
  .transform((inbox, context) => {
    // Older AgentMail responses used the address itself as inbox_id.
    const email = inbox.email ?? z.email().safeParse(inbox.inbox_id).data;
    if (!email) {
      context.addIssue({ code: "custom", message: "Missing inbox address" });
      return z.NEVER;
    }
    return {
      inboxId: inbox.inbox_id,
      email,
      displayName: inbox.display_name,
    };
  });

const messageItemSchema = z.object({
  inbox_id: z.string().min(1),
  message_id: z.string().min(1),
  thread_id: z.string().min(1),
  labels: z.array(z.string()),
  timestamp: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  preview: z.string().optional(),
});

const messagePageSchema = z.object({
  count: z.number().int().nonnegative(),
  messages: z.array(messageItemSchema),
  next_page_token: z.string().optional(),
});

const messageSchema = messageItemSchema.extend({
  text: z.string().optional(),
  html: z.string().optional(),
  extracted_text: z.string().optional(),
  extracted_html: z.string().optional(),
});

const sendInputSchema = z.object({
  to: z.array(z.email()).min(1),
  subject: z.string(),
  text: z.string().min(1),
});

const sendResultSchema = z.object({
  message_id: z.string().min(1),
  thread_id: z.string().min(1),
});

const idempotencyKeySchema = z.string().regex(/^[A-Za-z\d._~-]{1,256}$/u);

function retryDelay(response: Response, attempt: number) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter === null) return 500 * 2 ** attempt;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(retryAfter);
  return Number.isFinite(date)
    ? Math.max(0, date - Date.now())
    : 500 * 2 ** attempt;
}

async function agentMailRequest<Schema extends z.ZodType>(
  schema: Schema,
  url: URL,
  options: {
    readonly body?: z.JSONType;
    readonly idempotencyKey?: string;
    readonly method?: "GET" | "POST";
  } = {}
): Promise<z.output<Schema>> {
  const apiKey = env.AGENTMAIL_API_KEY;
  if (!apiKey) {
    throw new Error("AGENTMAIL_API_KEY is not set on this deployment.");
  }
  const headers = new Headers({ Authorization: `Bearer ${apiKey}` });
  if (options.body !== undefined)
    headers.set("Content-Type", "application/json");
  if (options.idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  /* oxlint-disable eslint/no-await-in-loop -- Provider retries must wait for the previous response and its backoff. */
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        body: options.body === undefined ? null : JSON.stringify(options.body),
        headers,
        method: options.method ?? "GET",
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new Error("AgentMail request could not reach the provider.");
    }

    if (
      attempt < maximumRetries &&
      (response.status === 429 || response.status >= 500)
    ) {
      const delay = retryDelay(response, attempt);
      // A long Retry-After is returned to the caller, never retried early.
      if (delay <= maximumRetryDelayMs) {
        await response.body?.cancel().catch(() => undefined);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        continue;
      }
    }

    const payload = await response
      .json()
      .then((value) => z.json().parse(value))
      .catch(() => undefined);
    if (!response.ok) {
      const error = providerErrorSchema.safeParse(payload).data;
      throw new AgentMailError(response.status, error?.code);
    }
    const result = schema.safeParse(payload);
    if (!result.success) {
      // Zod issues can contain email content. Keep them out of error messages.
      throw new Error("AgentMail returned an invalid response.");
    }
    return result.data;
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

export function createAgentMailInbox(workspaceId: string) {
  const workspaceHash = createHash("sha256").update(workspaceId).digest("hex");
  return agentMailRequest(inboxSchema, new URL(`${apiOrigin}/inboxes`), {
    body: { client_id: `bro-inbox-${workspaceHash}`, display_name: "Bro" },
    method: "POST",
  });
}

export function listAgentMailMessages(
  inboxId: string,
  options: { readonly limit?: number; readonly pageToken?: string } = {}
) {
  const url = new URL(
    `${apiOrigin}/inboxes/${encodeURIComponent(inboxId)}/messages`
  );
  if (options.limit !== undefined) {
    url.searchParams.set(
      "limit",
      String(z.number().int().min(1).max(100).parse(options.limit))
    );
  }
  if (options.pageToken !== undefined)
    url.searchParams.set("page_token", options.pageToken);
  return agentMailRequest(messagePageSchema, url);
}

export function readAgentMailMessage(inboxId: string, messageId: string) {
  return agentMailRequest(
    messageSchema,
    new URL(
      `${apiOrigin}/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`
    )
  );
}

/** Retries preserve the provider's organization-scoped 24-hour send key. */
export function sendAgentMailMessage(
  inboxId: string,
  input: z.input<typeof sendInputSchema>,
  idempotencyKey: string
) {
  return agentMailRequest(
    sendResultSchema,
    new URL(
      `${apiOrigin}/inboxes/${encodeURIComponent(inboxId)}/messages/send`
    ),
    {
      body: sendInputSchema.parse(input),
      idempotencyKey: idempotencyKeySchema.parse(idempotencyKey),
      method: "POST",
    }
  );
}
