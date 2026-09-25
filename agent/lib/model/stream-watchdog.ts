import { z } from "zod";

/**
 * OpenRouter calls that go quiet are cut short and tried again. Nothing bounded
 * a model call before: on 25.09 two turns sat on one step for 6 and 8.5
 * minutes after `browser_task start`, and each went on only when the step ran
 * again in a fresh process — the shape of a call that waited out undici's
 * five-minute timeouts and a workflow step retry.
 *
 * A stream counts as alive only while it carries `data:` events; the
 * `: OPENROUTER PROCESSING` comments OpenRouter sends while it waits do not
 * count. A call with no event yet has streamed nothing to eve, so it is sent
 * again in place; one that stalls halfway fails its stream, and eve's step
 * fails with it instead of hanging.
 */
const firstEventTimeoutMs = 60_000;
const eventGapTimeoutMs = 60_000;
const maximumAttempts = 2;

class ModelStreamStalledError extends Error {
  override readonly name = "ModelStreamStalledError";
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
  const stalled = new ModelStreamStalledError(
    `OpenRouter sent no event for ${String(firstEventTimeoutMs / 1000)} s.`
  );
  const timer = setTimeout(() => {
    controller.abort(stalled);
  }, firstEventTimeoutMs);
  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    if (!response.body || !isEventStream(response)) {
      clearTimeout(timer);
      release();
      return response;
    }
    const reader = response.body.getReader();
    const events = eventLines();
    const head = await readUntilFirstEvent(reader, events, []);
    clearTimeout(timer);
    return new Response(
      watchedBody({ controller, events, head, reader, release }),
      {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      }
    );
  } catch (error) {
    clearTimeout(timer);
    release();
    if (controller.signal.reason !== stalled || caller?.aborted) throw error;
    console.warn("[model] OpenRouter stream stalled before its first event", {
      attempt,
      model: requestedModel(init),
      waitedMs: firstEventTimeoutMs,
    });
    if (attempt >= maximumAttempts || !resendable(init)) throw stalled;
    return attemptModelFetch(input, init, attempt + 1);
  }
}

function isEventStream(response: Response) {
  return (
    response.headers.get("content-type")?.includes("text/event-stream") === true
  );
}

/** A JSON body can go out again; a stream was spent by the first attempt. */
function resendable(init: RequestInit | undefined) {
  return init?.body === undefined || z.string().safeParse(init.body).success;
}

const modelRequestSchema = z.object({ model: z.string() });

/** The model the call asked for, for the log line; nothing when unreadable. */
function requestedModel(init: RequestInit | undefined) {
  const body = z.string().safeParse(init?.body);
  if (!body.success) return undefined;
  try {
    return modelRequestSchema.safeParse(JSON.parse(body.data)).data?.model;
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
  head: Uint8Array[]
): Promise<Uint8Array[]> {
  const { done, value } = await reader.read();
  if (done) return head;
  const read = [...head, value];
  return sawEvent(value) ? read : readUntilFirstEvent(reader, sawEvent, read);
}

function watchedBody(options: {
  readonly controller: AbortController;
  readonly events: (chunk: Uint8Array) => boolean;
  readonly head: readonly Uint8Array[];
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly release: () => void;
}) {
  const { controller, events, head, reader, release } = options;
  const stalled = new ModelStreamStalledError(
    `OpenRouter stream went ${String(eventGapTimeoutMs / 1000)} s without an event.`
  );
  let gap: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(gap);
    gap = setTimeout(() => {
      controller.abort(stalled);
    }, eventGapTimeoutMs);
  };
  const finish = () => {
    clearTimeout(gap);
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
        if (events(value)) arm();
        stream.enqueue(value);
      } catch (error) {
        finish();
        if (controller.signal.reason === stalled) {
          console.warn("[model] OpenRouter stream stalled mid-answer", {
            waitedMs: eventGapTimeoutMs,
          });
          stream.error(stalled);
          return;
        }
        stream.error(error);
      }
    },
    start(stream) {
      for (const chunk of head) stream.enqueue(chunk);
      arm();
    },
  });
}
