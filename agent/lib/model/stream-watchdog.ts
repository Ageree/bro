import { z } from "zod";
import { env } from "@shared/environment";

/**
 * OpenRouter calls that go silent are cut short. Nothing bounded a model call
 * before: on 25.09 two turns sat on one step for 6 and 8.5 minutes after
 * `browser_task start`, and each went on only when the step ran again in a
 * fresh process — the shape of a connection that stopped sending anything
 * and waited out undici's five-minute timeouts.
 *
 * Two limits, because a dead connection and a slow model look different:
 *
 * - Idle: no byte at all for `idleTimeoutMs`. OpenRouter keeps a live call
 *   talking with `: OPENROUTER PROCESSING` comments while the model prefills
 *   or thinks, so silence means the connection is gone. Before the first
 *   `data:` event nothing has reached eve, so the call is sent again once.
 * - Slow: no `data:` event for `dataCeilingMs()` although comments keep
 *   coming. The model is working; a second call would be as slow and billed
 *   twice, so the call fails instead, and only long past any healthy answer.
 *
 * Mid-answer the same two limits fail the stream, and eve's step fails with
 * it instead of hanging.
 */
const idleTimeoutMs = 90_000;
const maximumAttempts = 2;

/** Hidden reasoning streams nothing but comments, for minutes at high effort. */
function dataCeilingMs() {
  return env.OPENROUTER_REASONING_EFFORT === "off" ? 240_000 : 480_000;
}

class ModelStreamStalledError extends Error {
  override readonly name = "ModelStreamStalledError";
  readonly idle: boolean;

  constructor(idle: boolean, waitedMs: number) {
    super(
      idle
        ? `OpenRouter sent nothing for ${String(waitedMs / 1000)} s.`
        : `OpenRouter sent no answer for ${String(waitedMs / 1000)} s.`
    );
    this.idle = idle;
  }
}

/** A `fetch` for the OpenRouter provider that bounds every silence. */
export async function watchedModelFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  return attemptModelFetch(input, init, 1);
}

async function attemptModelFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
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
  const timers = stallTimers(controller, request?.stream === true);
  timers.start();
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
    timers.bytes();
    const reader = response.body.getReader();
    const events = eventLines();
    const head = await readUntilFirstEvent(reader, events, timers, []);
    timers.data();
    return new Response(
      watchedBody({ controller, events, head, reader, release, timers }),
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
    console.warn("[model] OpenRouter call stalled before its answer", {
      attempt,
      idle: stalled.idle,
      model: request?.model,
    });
    // Only a silent connection is sent again: nothing reached eve yet, and a
    // model that was still working would only be as slow a second time.
    if (!stalled.idle || attempt >= maximumAttempts || !resendable(init)) {
      throw stalled;
    }
    return attemptModelFetch(input, init, attempt + 1);
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
function stallTimers(controller: AbortController, watchIdle: boolean) {
  const ceilingMs = dataCeilingMs();
  let idle: ReturnType<typeof setTimeout> | undefined;
  let ceiling: ReturnType<typeof setTimeout> | undefined;
  const bytes = () => {
    if (!watchIdle) return;
    clearTimeout(idle);
    idle = setTimeout(() => {
      controller.abort(new ModelStreamStalledError(true, idleTimeoutMs));
    }, idleTimeoutMs);
  };
  const data = () => {
    bytes();
    clearTimeout(ceiling);
    ceiling = setTimeout(() => {
      controller.abort(new ModelStreamStalledError(false, ceilingMs));
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
  stream: z.boolean().optional(),
});

/** What the call asked for: the model, and whether it streams. */
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

function watchedBody(options: {
  readonly controller: AbortController;
  readonly events: (chunk: Uint8Array) => boolean;
  readonly head: readonly Uint8Array[];
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly release: () => void;
  readonly timers: StallTimers;
}) {
  const { controller, events, head, reader, release, timers } = options;
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
          stream.close();
          return;
        }
        if (events(value)) timers.data();
        else timers.bytes();
        stream.enqueue(value);
      } catch (error) {
        finish();
        const stalled = stallOf(controller);
        if (stalled) {
          console.warn("[model] OpenRouter stream stalled mid-answer", {
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
