import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchedModelFetch } from "../stream-watchdog";

// OpenRouter as the provider sees it: a server-sent event stream the test
// writes into, which fails the way undici's does when its request is aborted.
function eventStream(signal: AbortSignal | undefined) {
  const encoder = new TextEncoder();
  let writer: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      writer = controller;
    },
  });
  signal?.addEventListener("abort", () => {
    writer?.error(signal.reason);
  });
  return {
    close: () => writer?.close(),
    response: new Response(body, {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    }),
    write: (text: string) => writer?.enqueue(encoder.encode(text)),
  };
}

type Stream = ReturnType<typeof eventStream>;

const calls: { init?: RequestInit; stream: Stream }[] = [];

function openRouterFetch() {
  return vi.fn<typeof fetch>((_input, init) => {
    const stream = eventStream(init?.signal ?? undefined);
    calls.push({ init, stream });
    return Promise.resolve(stream.response);
  });
}

const request = {
  body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash", stream: true }),
  method: "POST",
};

async function readAll(response: Response) {
  return new Response(response.body).text();
}

/**
 * What the promise settled with — its value or its error — so a case can
 * move the clock first and look at a rejection after, without leaving it
 * unhandled in between.
 */
async function settled(promise: Promise<Response | string>) {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  calls.length = 0;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the OpenRouter stall watchdog", () => {
  it("passes a live stream through untouched", async () => {
    const fetch = openRouterFetch();
    vi.stubGlobal("fetch", fetch);

    const answer = watchedModelFetch("https://openrouter.test", request);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    calls[0]?.stream.write(": OPENROUTER PROCESSING\n\n");
    calls[0]?.stream.write(
      'data: {"choices":[{"delta":{"content":"При"}}]}\n\n'
    );
    const response = await answer;
    calls[0]?.stream.write(
      'data: {"choices":[{"delta":{"content":"вет"}}]}\n\n'
    );
    calls[0]?.stream.write("data: [DONE]\n\n");
    calls[0]?.stream.close();

    await expect(readAll(response)).resolves.toBe(
      [
        ": OPENROUTER PROCESSING\n\n",
        'data: {"choices":[{"delta":{"content":"При"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"вет"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join("")
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("sends a call again when only keep-alive comments came for a minute", async () => {
    vi.stubGlobal("fetch", openRouterFetch());

    const answer = watchedModelFetch("https://openrouter.test", request);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    // The provider behind OpenRouter went silent; OpenRouter keeps the
    // connection open with comments.
    calls[0]?.stream.write(": OPENROUTER PROCESSING\n\n");
    await vi.advanceTimersByTimeAsync(30_000);
    calls[0]?.stream.write(": OPENROUTER PROCESSING\n\n");
    await vi.advanceTimersByTimeAsync(30_000);

    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]?.init?.body).toBe(request.body);
    calls[1]?.stream.write("data: [DONE]\n\n");
    calls[1]?.stream.close();

    await expect(readAll(await answer)).resolves.toBe("data: [DONE]\n\n");
    expect(console.warn).toHaveBeenCalledWith(
      "[model] OpenRouter stream stalled before its first event",
      {
        attempt: 1,
        model: "deepseek/deepseek-v4.1-flash",
        waitedMs: 60_000,
      }
    );
  });

  it("gives up after the second silent attempt instead of hanging the turn", async () => {
    vi.stubGlobal("fetch", openRouterFetch());

    const answer = settled(
      watchedModelFetch("https://openrouter.test", request)
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await answer).toMatchObject({ name: "ModelStreamStalledError" });
    expect(calls).toHaveLength(2);
  });

  it("fails a stream that goes silent halfway, so the step fails instead of hanging", async () => {
    vi.stubGlobal("fetch", openRouterFetch());

    const answer = watchedModelFetch("https://openrouter.test", request);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    calls[0]?.stream.write(
      'data: {"choices":[{"delta":{"content":"При"}}]}\n\n'
    );
    const reading = settled(readAll(await answer));
    // Comments alone do not keep it alive.
    calls[0]?.stream.write(": OPENROUTER PROCESSING\n\n");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await reading).toMatchObject({ name: "ModelStreamStalledError" });
    expect(calls).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(
      "[model] OpenRouter stream stalled mid-answer",
      { waitedMs: 60_000 }
    );
  });

  it("counts an event split across two chunks", async () => {
    vi.stubGlobal("fetch", openRouterFetch());

    const answer = watchedModelFetch("https://openrouter.test", request);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    calls[0]?.stream.write("da");
    calls[0]?.stream.write('ta: {"choices":[]}\n\n');
    const response = await answer;
    calls[0]?.stream.close();

    await expect(readAll(response)).resolves.toBe('data: {"choices":[]}\n\n');
  });

  it("leaves a call the caller aborted to the caller", async () => {
    vi.stubGlobal("fetch", openRouterFetch());
    const caller = new AbortController();

    const answer = watchedModelFetch("https://openrouter.test", {
      ...request,
      signal: caller.signal,
    });
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    caller.abort(new Error("turn cancelled"));

    await expect(answer).rejects.toThrow("turn cancelled");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(1);
  });

  it("passes a plain JSON answer through without watching it", async () => {
    const json = new Response('{"id":"gen-1"}', {
      headers: { "content-type": "application/json" },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(json));
    vi.stubGlobal("fetch", fetch);

    const response = await watchedModelFetch("https://openrouter.test", {
      body: "{}",
      method: "POST",
    });

    expect(response).toBe(json);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
