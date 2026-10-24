import { z } from "zod";
import { env } from "@shared/environment";
import { type PageAnswer, sendInPage } from "./page";

/**
 * YClients' REST API for online booking (developers.yclients.com/ru, the
 * «Онлайн-запись» section: `bookform`, `book_services`, `book_staff`,
 * `book_dates`, `book_times`, `book_code`, `book_record`, `company`). It
 * takes YClients' own booking widget token (YCLIENTS_TOKEN): YClients
 * gives no partner tokens while it remakes its API (23.10, ticket
 * #4754816), and every salon's public booking form sends that token. Every
 * answer is an envelope `{success, data, meta}`; a refusal carries its
 * reasons in `meta.errors` with YClients' own codes (433: the time is
 * taken). The calls go from the person's own pool browser (`page.ts`).
 */

/**
 * Whether the workspace books through YClients (YCLIENTS_WORKSPACES: its id
 * or `*`) and the deployment has the token. Unset, nobody does.
 */
export function yclientsPilot(scope: { readonly workspaceId: string }) {
  const list = env.YCLIENTS_WORKSPACES ?? [];
  return (
    env.YCLIENTS_TOKEN !== undefined &&
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
 * A refusal of YClients, or no answer: the HTTP status (0 when none came),
 * its error codes, and whether it came as YClients' own envelope (not a
 * gateway's or a WAF's page). The message is YClients' own text, for the
 * code and the log only: the model repeats what it reads.
 */
export class YclientsError extends Error {
  override readonly name = "YclientsError";

  constructor(
    readonly status: number,
    readonly codes: readonly number[],
    message: string,
    readonly envelope = false
  ) {
    super(message);
  }
}

/** One call of the API, its path under `/api/v1`. */
export interface YclientsRequest {
  readonly body?: z.core.util.JSONType;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: URLSearchParams;
}

/** A call's outcome: its data, or YClients' refusal (or no answer). */
type YclientsAnswer =
  | { readonly data: z.core.util.JSONType; readonly kind: "ok" }
  | { readonly error: YclientsError; readonly kind: "refused" };

/** The data of an answer, or its refusal thrown. */
export function dataOf(answer: YclientsAnswer | undefined) {
  if (answer === undefined) {
    throw new YclientsError(0, [], "No answer for the call.");
  }
  if (answer.kind === "refused") throw answer.error;
  return answer.data;
}

/**
 * The calls, made together from one tab, and each one's outcome in order.
 * Throws `YclientsPageError` when the tab could not make them; its `sent`
 * says whether they may have gone out (`writes`: a change is among them).
 */
export async function yclientsCalls(
  workspaceId: string,
  requests: readonly YclientsRequest[],
  options: { readonly writes?: boolean } = {}
): Promise<YclientsAnswer[]> {
  const token = env.YCLIENTS_TOKEN;
  if (token === undefined) {
    return requests.map(() => ({
      error: new YclientsError(0, [], "YCLIENTS_TOKEN is not set."),
      kind: "refused",
    }));
  }
  const answers = await sendInPage(
    workspaceId,
    token,
    requests.map((one) => {
      const query = one.query?.toString();
      return {
        body: one.body === undefined ? null : JSON.stringify(one.body),
        method: one.method,
        path: `/api/v1${one.path}${query ? `?${query}` : ""}`,
      };
    }),
    options.writes ?? false
  );
  return answers.map(readAnswer);
}

function readAnswer(answer: PageAnswer): YclientsAnswer {
  const ok = answer.status >= 200 && answer.status < 300;
  // book_check and book_code may answer 201 with nothing in it.
  if (ok && answer.text.trim() === "") return { data: null, kind: "ok" };
  const parsed = envelopeSchema.safeParse(parseJson(answer.text));
  if (!parsed.success) {
    return {
      error: new YclientsError(
        answer.status,
        [],
        `HTTP ${String(answer.status)} with no envelope`
      ),
      kind: "refused",
    };
  }
  const envelope = parsed.data;
  if (!ok || !envelope.success) {
    const meta = Array.isArray(envelope.meta) ? undefined : envelope.meta;
    return {
      error: new YclientsError(
        answer.status,
        (meta?.errors ?? []).flatMap((error) =>
          error.code === undefined ? [] : [error.code]
        ),
        [meta?.message, ...(meta?.errors ?? []).map((error) => error.message)]
          .filter(Boolean)
          .join("; ") || `HTTP ${String(answer.status)}`,
        true
      ),
      kind: "refused",
    };
  }
  return { data: envelope.data ?? null, kind: "ok" };
}

function parseJson(text: string) {
  try {
    return z.json().parse(JSON.parse(text));
  } catch {
    return null;
  }
}
