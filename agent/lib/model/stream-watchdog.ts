import { z } from "zod";
import { modelEndpoint } from "./endpoint";
import { callConversationOf } from "./routerai/warm";

/**
 * Direct model calls (OpenRouter or RouterAI) that go silent are cut short. Nothing bounded a model call
 * before: on 25.09 two turns sat on one step for 6 and 8.5 minutes after
 * `browser_task start`, and each went on only when the step ran again in a
 * fresh process — the shape of a connection that stopped sending anything
 * and waited out undici's five-minute timeouts.
 *
 * Two limits, because a dead connection and a slow model look different:
 *
 * - Idle: no byte at all for `idleTimeoutMs`. OpenRouter keeps a live call
 *   talking with `: OPENROUTER PROCESSING` comments while the model prefills
 *   or thinks, RouterAI with `: PROCESSING` about once a second, and any byte
 *   counts, so silence means the connection is gone. Before the first
 *   `data:` event nothing has reached eve, so the call is sent again once.
 * - Slow: no `data:` event for `dataCeilingMs()` although comments keep
 *   coming. The model is working; a second call would be as slow and billed
 *   twice, so the call fails instead, and only long past any healthy answer.
 *
 * Mid-answer the same two limits fail the stream, and eve's step fails with
 * it instead of hanging. RouterAI's own DeepSeek endpoint sends nothing but
 * comments for minutes (01.10): the ceiling is what ends such a call when
 * provider routing did not skip it.
 */
const idleTimeoutMs = 90_000;
const maximumAttempts = 2;

/** Hidden reasoning streams nothing but comments, for minutes at high effort. */
function dataCeilingMs() {
  return modelEndpoint()?.reasoningEffort === "off" ? 240_000 : 480_000;
}

/** The backend the error texts and logs name. */
function backendName() {
  return modelEndpoint()?.name ?? "The model provider";
}

/**
 * A call cut short. `idle` is a connection that sent nothing at all: a
 * route that is down, as `routerai/fallback.ts` reads it, not a slow model.
 */
export class ModelStreamStalledError extends Error {
  override readonly name = "ModelStreamStalledError";
  readonly idle: boolean;

  constructor(idle: boolean, waitedMs: number, backend: string) {
    super(
      idle
        ? `${backend} sent nothing for ${String(waitedMs / 1000)} s.`
        : `${backend} sent no answer for ${String(waitedMs / 1000)} s.`
    );
    this.idle = idle;
  }
}

/**
 * A `fetch` for the direct model provider that bounds every silence.
 * `backend` names who stalled in the error and the logs: the provider's
 * fallback (`routerai/fallback.ts`) is not the provider.
 */
export async function watchedModelFetch(
  input: string | URL | Request,
  init?: RequestInit,
  backend = backendName()
): Promise<Response> {
  return attemptModelFetch(input, init, backend, 1);
}

async function attemptModelFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  backend: string,
  attempt: number
): Promise<Response> {
  const controller = new AbortController();
  const caller = init?.signal ?? undefined;
  const followCaller = () => {
    controller.abort(caller?.reason);
  };
  if (caller?.aborted) followCaller();
  else caller?.addEventListener("abort", followCaller, { once: true });
  const release = () => {
    caller?.removeEventListener("abort", followCaller);
  };
  const request = modelRequest(init);
  // A call that does not stream may hold its headers until the whole answer
  // is ready: only the ceiling applies to it.
  const timers = stallTimers(controller, request?.stream === true, backend);
  timers.start();
  const startedAt = performance.now();
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    if (!response.body || !isEventStream(response)) {
      timers.stop();
      release();
      return response;
    }
    const headersMs = performance.now() - startedAt;
    timers.bytes();
    const reader = response.body.getReader();
    const events = eventLines();
    const head = await readUntilFirstEvent(reader, events, timers, []);
    timers.data();
    const timing = callTiming({
      attempt,
      backend,
      firstDataMs: performance.now() - startedAt,
      headersMs,
      model: request?.model,
      reasoning:
        request?.reasoning_effort ??
        (request?.reasoning === undefined
          ? undefined
          : request.reasoning.enabled === false
            ? "none"
            : "on"),
      startedAt,
    });
    for (const chunk of head) timing.read(chunk);
    return new Response(
      watchedBody({
        backend,
        controller,
        events,
        head,
        reader,
        release,
        timers,
        timing,
      }),
      {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      }
    );
  } catch (error) {
    timers.stop();
    release();
    const stalled = stallOf(controller);
    if (!stalled || caller?.aborted) throw error;
    console.warn("[model] direct model call stalled before its answer", {
      attempt,
      backend,
      idle: stalled.idle,
      model: request?.model,
    });
    // Only a silent connection is sent again: nothing reached eve yet, and a
    // model that was still working would only be as slow a second time.
    if (!stalled.idle || attempt >= maximumAttempts || !resendable(init)) {
      throw stalled;
    }
    return attemptModelFetch(input, init, backend, attempt + 1);
  }
}

function stallOf(controller: AbortController) {
  const reason: unknown = controller.signal.reason;
  return reason instanceof ModelStreamStalledError ? reason : undefined;
}

/**
 * The idle timer restarts on every byte, comments included; the ceiling only
 * on a `data:` event. Either one firing aborts the call with its reason.
 */
function stallTimers(
  controller: AbortController,
  watchIdle: boolean,
  backend: string
) {
  const ceilingMs = dataCeilingMs();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let ceiling: ReturnType<typeof setTimeout> | undefined;
  const bytes = () => {
    if (!watchIdle) return;
    clearTimeout(idle);
    idle = setTimeout(() => {
      controller.abort(
        new ModelStreamStalledError(true, idleTimeoutMs, backend)
      );
    }, idleTimeoutMs);
  };
  const data = () => {
    bytes();
    clearTimeout(ceiling);
    ceiling = setTimeout(() => {
      controller.abort(new ModelStreamStalledError(false, ceilingMs, backend));
    }, ceilingMs);
  };
  return {
    bytes,
    data,
    start: data,
    stop: () => {
      clearTimeout(idle);
      clearTimeout(ceiling);
    },
  };
}

type StallTimers = ReturnType<typeof stallTimers>;

function isEventStream(response: Response) {
  return (
    response.headers.get("content-type")?.includes("text/event-stream") === true
  );
}

/** A JSON body can go out again; a stream was spent by the first attempt. */
function resendable(init: RequestInit | undefined) {
  return init?.body === undefined || z.string().safeParse(init.body).success;
}

const modelRequestSchema = z.object({
  model: z.string().optional(),
  // RunInfra's field, and OpenRouter's (RouterAI's) object.
  reasoning: z.looseObject({ enabled: z.boolean().optional() }).optional(),
  reasoning_effort: z.string().optional(),
  stream: z.boolean().optional(),
});

/** What the call asked for: the model, whether it streams and reasons. */
function modelRequest(init: RequestInit | undefined) {
  const body = z.string().safeParse(init?.body);
  if (!body.success) return undefined;
  try {
    return modelRequestSchema.safeParse(JSON.parse(body.data)).data;
  } catch {
    return undefined;
  }
}

/**
 * Whether the stream carried a `data:` line in the chunk just read. Only the
 * start of the line in progress is kept between chunks: that is all a line's
 * kind depends on, and a long event is not copied again with every chunk.
 */
function eventLines() {
  const decoder = new TextDecoder();
  let lineStart = "";
  return (chunk: Uint8Array) => {
    const lines =
      `${lineStart}${decoder.decode(chunk, { stream: true })}`.split("\n");
    const current = lines.pop() ?? "";
    lineStart = current.slice(0, "data:".length);
    return (
      lines.some((line) => line.startsWith("data:")) ||
      current.startsWith("data:")
    );
  };
}

async function readUntilFirstEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sawEvent: (chunk: Uint8Array) => boolean,
  timers: StallTimers,
  head: Uint8Array[]
): Promise<Uint8Array[]> {
  const { done, value } = await reader.read();
  if (done) return head;
  timers.bytes();
  const read = [...head, value];
  return sawEvent(value)
    ? read
    : readUntilFirstEvent(reader, sawEvent, timers, read);
}

/**
 * One line per streamed model call (`[model] call`) for the reply's latency:
 * the backend, the milliseconds to the headers, to the first `data:` event
 * and to the end of the answer, and the tokens its last event reports — no
 * text. A person waits on the whole call: the answer is read whole before eve
 * gets it (`routerai/fetch.ts`). A person's call names its session, as its
 * `[tools]` and `[model] prefix` lines do.
 */
function callTiming(call: {
  readonly attempt: number;
  readonly backend: string;
  readonly firstDataMs: number;
  readonly headersMs: number;
  readonly model: string | undefined;
  readonly reasoning: string | undefined;
  readonly startedAt: number;
}) {
  const decoder = new TextDecoder();
  const sessionId = callConversationOf();
  // The usage event is the last one: the tail of the stream is enough.
  let tail = "";
  const tokens = (name: string) => {
    const found = new RegExp(`"${name}":(\\d+)`, "u").exec(tail)?.[1];
    return found === undefined ? undefined : Number(found);
  };
  return {
    done() {
      console.info("[model] call", {
        // When the answer ended, to line the call up with the turn's other
        // lines (the journal keeps whole seconds only).
        at: Date.now(),
        attempt: call.attempt,
        backend: call.backend,
        cachedTokens: tokens("cached_tokens"),
        firstDataMs: Math.round(call.firstDataMs),
        headersMs: Math.round(call.headersMs),
        inputTokens: tokens("prompt_tokens"),
        model: call.model,
        outputTokens: tokens("completion_tokens"),
        reasoning: call.reasoning,
        reasoningTokens: tokens("reasoning_tokens"),
        sessionId,
        totalMs: Math.round(performance.now() - call.startedAt),
      });
    },
    read(chunk: Uint8Array) {
      tail = `${tail}${decoder.decode(chunk, { stream: true })}`.slice(-4096);
    },
  };
}

function watchedBody(options: {
  readonly backend: string;
  readonly controller: AbortController;
  readonly events: (chunk: Uint8Array) => boolean;
  readonly head: readonly Uint8Array[];
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly release: () => void;
  readonly timers: StallTimers;
  readonly timing: ReturnType<typeof callTiming>;
}) {
  const { backend, controller, events, head, reader, release, timers, timing } =
    options;
  const finish = () => {
    timers.stop();
    release();
  };
  return new ReadableStream<Uint8Array>({
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
    async pull(stream) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          timing.done();
          stream.close();
          return;
        }
        if (events(value)) timers.data();
        else timers.bytes();
        timing.read(value);
        stream.enqueue(value);
      } catch (error) {
        finish();
        const stalled = stallOf(controller);
        if (stalled) {
          console.warn("[model] direct model stream stalled mid-answer", {
            backend,
            idle: stalled.idle,
          });
          stream.error(stalled);
          return;
        }
        stream.error(error);
      }
    },
    start(stream) {
      for (const chunk of head) stream.enqueue(chunk);
    },
  });
}
