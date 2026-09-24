import { z } from "zod";
import { env } from "@shared/environment";

/** Composio REST API v3.1, the version its docs name current. */
const composioApiUrl = "https://backend.composio.dev/api/v3.1";

/** How long a Composio call without the caller's own signal may take. */
const defaultTimeoutMs = 20_000;

/**
 * Composio's own refusal of a request: a missing auth config or connected
 * account, a bad key, its rate limit. The upstream API's answer to a proxied
 * call is not one of these; it comes back as that call's status.
 */
export class ComposioError extends Error {
  override readonly name = "ComposioError";
  readonly slug: string | undefined;
  readonly status: number;

  constructor(status: number, slug: string | undefined, message: string) {
    super(message);
    this.slug = slug;
    this.status = status;
  }
}

const composioErrorBodySchema = z.object({
  error: z.object({ message: z.string(), slug: z.string().optional() }),
});

/** Whether this deployment reaches Composio at all. */
export function composioConfigured() {
  return env.COMPOSIO_API_KEY !== undefined;
}

type QueryValue = boolean | number | string | readonly string[] | undefined;

/**
 * One call to Composio's REST API with the project key, its answer checked
 * against `schema`. A list value in `query` repeats its parameter.
 */
export async function composioRequest<Schema extends z.ZodType>(
  schema: Schema,
  path: string,
  options: {
    readonly body?: unknown;
    readonly method?: "DELETE" | "GET" | "PATCH" | "POST";
    readonly query?: Readonly<Record<string, QueryValue>>;
    readonly signal?: AbortSignal;
  } = {}
): Promise<z.output<Schema>> {
  const apiKey = env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new Error("COMPOSIO_API_KEY is not set on this deployment.");
  }
  const url = new URL(`${composioApiUrl}${path}`);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, String(item));
    }
  }
  const headers = new Headers({ "x-api-key": apiKey });
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(url, {
    body: options.body === undefined ? null : JSON.stringify(options.body),
    headers,
    method: options.method ?? "GET",
    signal: options.signal ?? AbortSignal.timeout(defaultTimeoutMs),
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = composioErrorBodySchema.safeParse(payload).data?.error;
    throw new ComposioError(
      response.status,
      error?.slug,
      `Composio answered ${String(response.status)}${error ? `: ${error.message}` : "."}`
    );
  }
  return schema.parse(payload);
}

/**
 * Whether a failure to reach Composio may pass when tried again shortly: its
 * outage, throttling, a network error or a timeout. A missing key, auth
 * config or account is configuration and stays as it is.
 */
export function isTransientComposioFailure(cause: unknown) {
  if (cause instanceof ComposioError) {
    return cause.status === 408 || cause.status === 429 || cause.status >= 500;
  }
  return (
    cause instanceof TypeError ||
    (cause instanceof DOMException &&
      (cause.name === "TimeoutError" || cause.name === "AbortError"))
  );
}

/**
 * Whether Composio refused because the connected account a call named is
 * gone or unusable: deleted, expired, disabled. The person has to connect
 * again.
 */
export function isMissingConnectedAccount(cause: unknown) {
  return (
    cause instanceof ComposioError &&
    cause.status >= 400 &&
    cause.status < 500 &&
    cause.slug?.startsWith("ConnectedAccount_") === true
  );
}
