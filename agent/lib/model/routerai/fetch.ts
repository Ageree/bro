import { z } from "zod";
import { watchedModelFetch } from "../stream-watchdog";
import { failureStatus, reportedErrorSchema } from "./errors";
import { noteFailedHost, routedAroundFailedHosts } from "./hosts";

const answerSchema = z
  .object({
    choices: z
      .array(z.object({ finish_reason: z.string().nullish() }).loose())
      .optional(),
    error: reportedErrorSchema.nullish(),
    provider: z.string().optional(),
  })
  .loose();

/** What a JSON text holds, read by `schema`, or `undefined`. */
function parsedText<Schema extends z.ZodType>(schema: Schema, text: string) {
  try {
    return schema.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}

/** The answer (or one event of it) a text holds, if it holds one. */
function answerOf(text: string) {
  return parsedText(answerSchema, text);
}

type Answer = NonNullable<ReturnType<typeof answerOf>>;

/**
 * The error in the shape the provider package reads
 * (`OpenRouterErrorResponseSchema`: `{ code, message }`, more kept).
 */
function readableError(error: NonNullable<Answer["error"]>) {
  return {
    ...error,
    code: error.code ?? null,
    message: error.message ?? JSON.stringify(error),
  };
}

/**
 * A host that broke off its answer: RouterAI ends the stream with a chunk
 * whose `finish_reason` is `error` (01.10, Sail Research), which the provider
 * package cannot read and eve took for a malformed answer, not an outage.
 */
function brokenOff(answer: Answer) {
  return (answer.choices ?? []).some(
    (choice) => choice.finish_reason === "error"
  );
}

/**
 * What failed an answer or one event of it: an `error`, or a host that broke
 * off. The status is the one its code names, 502 for none; the host is the
 * upstream RouterAI names («Upstream error from Sail Research: …»).
 */
function failureOf(answer: Answer) {
  if (answer.error !== undefined && answer.error !== null) {
    const error = readableError(answer.error);
    return {
      error,
      host:
        /Upstream error from ([^:]+):/.exec(error.message)?.[1] ??
        answer.provider,
      status: failureStatus(error.code) ?? 502,
    };
  }
  if (!brokenOff(answer)) return undefined;
  const host = answer.provider ?? "The upstream host";
  return {
    error: readableError({
      code: 502,
      message: `${host} broke off its answer.`,
    }),
    host: answer.provider,
    status: 502,
  };
}

type Failure = NonNullable<ReturnType<typeof failureOf>>;

function rebuiltHeaders(response: Response) {
  const headers = new Headers(response.headers);
  // The body below is already decoded text of another length.
  headers.delete("content-encoding");
  headers.delete("content-length");
  return headers;
}

function isEventStream(response: Response) {
  return (
    response.headers.get("content-type")?.includes("text/event-stream") === true
  );
}

/** The `data:` payload of one line of an event stream, if it has one. */
function eventPayload(line: string) {
  const content = line.endsWith("\r") ? line.slice(0, -1) : line;
  return content.startsWith("data:")
    ? content.slice("data:".length).trim()
    : undefined;
}

/**
 * A whole (non-stream) answer's failure. HTTP 200 with an `error` and no
 * `choices` is a failure the provider package would read as a malformed
 * success, and so is a host that broke off. A failure status keeps its
 * status, whether the error is plain text («401 Unauthorized») or an object
 * (a 429 or 5xx `{"error":{…}}` naming the upstream host to skip).
 */
function wholeAnswerFailure(text: string, response: Response) {
  const answer = answerOf(text);
  if (answer === undefined) return undefined;
  const failure = failureOf(answer);
  if (failure === undefined) return undefined;
  if (response.ok) {
    const answered = (answer.choices ?? []).length > 0 && !brokenOff(answer);
    return answered ? undefined : failure;
  }
  return { ...failure, status: response.status };
}

/** The first event of a stream that failed it, if one did. */
function streamFailure(text: string) {
  for (const line of text.split("\n")) {
    const payload = eventPayload(line);
    const answer = payload === undefined ? undefined : answerOf(payload);
    const failure = answer === undefined ? undefined : failureOf(answer);
    if (failure !== undefined) return failure;
  }
  return undefined;
}

/**
 * One line of the event stream with a failed event made readable: its error
 * as an object, with `statusCode` its code names (502 for none), which is
 * where eve looks for one (`readStatusCode` in
 * `eve/dist/src/harness/model-call-error.js`) and what
 * `agent/lib/delivery/fallback.ts` tells an outage by.
 */
function readableEventLine(line: string) {
  const payload = eventPayload(line);
  const answer = payload === undefined ? undefined : answerOf(payload);
  const failure = answer === undefined ? undefined : failureOf(answer);
  if (answer === undefined || failure === undefined) return line;
  const { error, status } = failure;
  const readable = {
    ...answer,
    error: { ...error, code: error.code ?? status, statusCode: status },
  };
  // A broken-off chunk keeps no choice the provider package would read.
  if (brokenOff(answer)) readable.choices = [];
  const carriageReturn = line.endsWith("\r") ? "\r" : "";
  return `data: ${JSON.stringify(readable)}${carriageReturn}`;
}

/** The answer as the provider package can read it, failures included. */
function readableAnswer(
  text: string,
  response: Response,
  failure: Failure | undefined
) {
  const init = {
    headers: rebuiltHeaders(response),
    status: response.status,
    statusText: response.statusText,
  };
  if (failure === undefined) return new Response(text, init);
  if (isEventStream(response)) {
    return new Response(
      text.split("\n").map(readableEventLine).join("\n"),
      init
    );
  }
  const { error, status } = failure;
  return new Response(
    JSON.stringify({ error: { ...error, code: error.code ?? status } }),
    { ...init, status, statusText: response.ok ? "" : response.statusText }
  );
}

/** A failure another host may not have: an outage, not a refusal. */
function hostFailure(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

const attempts = 3;

/**
 * The `fetch` of the RouterAI model: the stall watchdog's, with two changes.
 *
 * RouterAI's errors are put in the shape `@openrouter/ai-sdk-provider`
 * reads. RouterAI answered many failures (probes of 01.10) as HTTP 200 with
 * `{"error":"<the upstream's JSON as text>"}` and no `choices`, in a stream
 * as `data: {"error":"…"}` before `[DONE]`, a provider's failure mid-answer
 * as `{"choices":[],"error":{"code":429,…}}`, and its own refusals as 4xx
 * with `{"error":"<plain text>"}`. Read as they come, a failure looked like
 * an empty success or lost its status, and a person out of credit or rate
 * limited heard «что-то сломалось» instead of «скоро вернусь».
 *
 * A pinned host that fails an answer is skipped (`hosts.ts`) and the call
 * goes out again at once. That is why the answer is read whole before it is
 * passed on: a failure often comes at its very end, after the tool call, and
 * nothing of a failed answer may reach eve. Bro sends its words through
 * `send_message`, so no person waits on the streamed text.
 */
export async function routerAiModelFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  return attemptRouterAiFetch(input, init, 1);
}

/**
 * One call through RouterAI with the model's failure reading and host
 * skipping, but no second try: a failed pinned host is noted, so the next
 * call skips it, and the failure is returned as is. For a call that is paid
 * per attempt (a web search bills its pages each time) and has its own
 * fallback.
 */
export async function routerAiFetchOnce(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  return attemptRouterAiFetch(input, init, attempts);
}

async function attemptRouterAiFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  attempt: number
): Promise<Response> {
  // The provider package sends its request as JSON text.
  const json = z.string().safeParse(init?.body).data;
  const sent = json === undefined ? undefined : routedAroundFailedHosts(json);
  const response = await watchedModelFetch(
    input,
    sent === undefined ? init : { ...init, body: sent }
  );
  if (!response.body) return response;
  const text = await response.text();
  const failure = isEventStream(response)
    ? streamFailure(text)
    : wholeAnswerFailure(text, response);
  const skipped =
    failure?.host !== undefined &&
    hostFailure(failure.status) &&
    sent !== undefined &&
    noteFailedHost(sent, failure.host);
  if (!skipped || attempt >= attempts || init?.signal?.aborted === true) {
    return readableAnswer(text, response, failure);
  }
  console.warn("[model] RouterAI host failed an answer, asking the next", {
    attempt,
    host: failure.host,
    status: failure.status,
  });
  return attemptRouterAiFetch(input, init, attempt + 1);
}
