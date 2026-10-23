import { z } from "zod";
import { env } from "@shared/environment";

/**
 * YClients' REST API for online booking (developers.yclients.com/ru, the
 * «Онлайн-запись» section): the booking form's own calls, which need only
 * the partner token — no sign-in of the salon or of the person. Every
 * answer is an envelope `{success, data, meta}`; a refusal carries its
 * reasons in `meta.errors` with YClients' own codes (433: the time is taken).
 */
const apiBase = "https://api.yclients.com/api/v1";
const requestTimeoutMs = 15_000;

/**
 * Whether the workspace books through YClients (YCLIENTS_WORKSPACES: its id
 * or `*`) and the deployment has the partner token. Unset, nobody does.
 */
export function yclientsPilot(scope: { readonly workspaceId: string }) {
  const list = env.YCLIENTS_WORKSPACES ?? [];
  return (
    env.YCLIENTS_PARTNER_TOKEN !== undefined &&
    (list.includes("*") || list.includes(scope.workspaceId))
  );
}

const envelopeSchema = z.object({
  data: z.json().optional(),
  meta: z
    .union([
      z.object({
        errors: z
          .array(
            z.object({
              code: z.coerce.number().optional(),
              message: z.string().optional(),
            })
          )
          .optional(),
        message: z.string().optional(),
      }),
      z.array(z.json()),
    ])
    .optional(),
  success: z.boolean(),
});

/**
 * A refusal of YClients: the HTTP status and its error codes. The message
 * is YClients' own text, for the log only: the model repeats what it reads.
 */
export class YclientsError extends Error {
  override readonly name = "YclientsError";

  constructor(
    readonly status: number,
    readonly codes: readonly number[],
    message: string
  ) {
    super(message);
  }
}

/**
 * One call of the API with the partner token. Answers the envelope's data;
 * throws `YclientsError` on a refusal and the fetch's own error when the
 * request did not go through — for a booking the two differ: after a
 * network error the booking may exist.
 */
export async function yclientsCall(
  method: "GET" | "POST",
  path: string,
  options: {
    readonly body?: z.core.util.JSONType;
    readonly query?: URLSearchParams;
    readonly signal?: AbortSignal;
  } = {}
) {
  const token = env.YCLIENTS_PARTNER_TOKEN;
  if (token === undefined) {
    throw new YclientsError(0, [], "YCLIENTS_PARTNER_TOKEN is not set.");
  }
  const query = options.query?.toString();
  const init: RequestInit = {
    headers: {
      accept: "application/vnd.yclients.v2+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method,
    signal: AbortSignal.any([
      AbortSignal.timeout(requestTimeoutMs),
      ...(options.signal === undefined ? [] : [options.signal]),
    ]),
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetch(
    `${apiBase}${path}${query ? `?${query}` : ""}`,
    init
  );
  const text = await response.text();
  // book_check may answer 201 with nothing in it (developers.yclients.com).
  if (response.ok && text.trim() === "") return null;
  const parsed = envelopeSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    throw new YclientsError(
      response.status,
      [],
      `HTTP ${String(response.status)} with no envelope`
    );
  }
  const envelope = parsed.data;
  if (!response.ok || !envelope.success) {
    const meta = Array.isArray(envelope.meta) ? undefined : envelope.meta;
    throw new YclientsError(
      response.status,
      (meta?.errors ?? []).flatMap((error) =>
        error.code === undefined ? [] : [error.code]
      ),
      meta?.message ?? `HTTP ${String(response.status)}`
    );
  }
  return envelope.data ?? null;
}

function parseJson(text: string) {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    return null;
  }
}
