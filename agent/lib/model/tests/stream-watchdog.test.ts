import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The reasoning effort decides how long a working model may go without an
// answer; each case sets it.
const environment = vi.hoisted(() => ({ OPENROUTER_REASONING_EFFORT: "off" }));
vi.mock("@shared/environment", () => ({ env: environment }));

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
  // An aborted request takes nothing more from the server.
  let aborted = false;
  signal?.addEventListener("abort", () => {
    aborted = true;
    writer?.error(signal.reason);
  });
  return {
    close: () => writer?.close(),
    response: new Response(body, {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    }),
    write: (text: string) => {
      if (!aborted) writer?.enqueue(encoder.encode(text));
    },
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

const comment = ": OPENROUTER PROCESSING\n\n";

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

/** OpenRouter's keep-alive while the model works: a comment every 10 s. */
async function keepAlive(stream: Stream | undefined, seconds: number) {
  for (let elapsed = 0; elapsed < seconds; elapsed += 10) {
    stream?.write(comment);
    // oxlint-disable-next-line eslint/no-await-in-loop -- The fake clock moves one keep-alive at a time.
    await vi.advanceTimersByTimeAsync(10_000);
  }
}

async function firstCall() {
  await vi.waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  return calls[0]?.stream;
}

beforeEach(() => {
  calls.length = 0;
  environment.OPENROUTER_REASONING_EFFORT = "off";
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
    const stream = await firstCall();
    stream?.write(comment);
    stream?.write('data: {"choices":[{"delta":{"content":"При"}}]}\n\n');
    const response = await answer;
    stream?.write('data: {"choices":[{"delta":{"content":"вет"}}]}\n\n');
    stream?.write("data: [DONE]\n\n");
    stream?.close();

    await expect(readAll(response)).resolves.toBe(
      [
        comment,
        'data: {"choices":[{"delta":{"content":"При"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"вет"}}]}\n\n',
        "data: [DONE]\n\n",
      ].join("")
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("lets a slow but working model take minutes to its first answer, once", async () => {
    // A long prefill or hidden reasoning: OpenRouter only sends comments.
    const fetch = openRouterFetch();
    vi.stubGlobal("fetch", fetch);

    const answer = watchedModelFetch("https://openrouter.test", request);
    const stream = await firstCall();
    await keepAlive(stream, 200);
    stream?.write("data: [DONE]\n\n");
    stream?.close();

    await expect(readAll(await answer)).resolves.toContain("data: [DONE]");
    expect(fetch).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("gives a model that reasons longer still", async () => {
    environment.OPENROUTER_REASONING_EFFORT = "high";
    const fetch = openRouterFetch();
    vi.stubGlobal("fetch", fetch);

    const answer = watchedModelFetch("https://openrouter.test", request);
    const stream = await firstCall();
    await keepAlive(stream, 400);
    stream?.write("data: [DONE]\n\n");
    stream?.close();

    await expect(readAll(await answer)).resolves.toContain("data: [DONE]");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("fails without a second billed call when comments come long past any healthy answer", async () => {
    vi.stubGlobal("fetch", openRouterFetch());

    const answer = settled(
      watchedModelFetch("https://openrouter.test", request)
    );
    await keepAlive(await firstCall(), 250);

    expect(await answer).toMatchObject({
      idle: false,
      name: "ModelStreamStalledError",
    });
    expect(calls).toHaveLength(1);
  });

  it("sends a call again when the connection went silent before any answer", async () => {
    vi.stubGlobal("fetch", openRouterFetch());

    const answer = watchedModelFetch("https://openrouter.test", request);
    // A comment or two, then nothing at all: the connection is gone.
    await keepAlive(await firstCall(), 20);
    await vi.advanceTimersByTimeAsync(90_000);

    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]?.init?.body).toBe(request.body);
    calls[1]?.stream.write("data: [DONE]\n\n");
    calls[1]?.stream.close();

    await expect(readAll(await answer)).resolves.toBe("data: [DONE]\n\n");
    expect(console.warn).toHaveBeenCalledWith(
      "[model] OpenRouter call stalled before its answer",
      { attempt: 1, idle: true, model: "deepseek/deepseek-v4.1-flash" }
    );
  });

  it("gives up after the second silent attempt instead of hanging the turn", async () => {
    vi.stubGlobal("fetch", openRouterFetch());

    const answer = settled(
      watchedModelFetch("https://openrouter.test", request)
    );
    await vi.advanceTimersByTimeAsync(90_000);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    await vi.advanceTimersByTimeAsync(90_000);

    expect(await answer).toMatchObject({
      idle: true,
      name: "ModelStreamStalledError",
    });
    expect(calls).toHaveLength(2);
  });

  it("keeps a stream alive through comments mid-answer and fails it once it goes silent", async () => {
    vi.stubGlobal("fetch", openRouterFetch());

    const answer = watchedModelFetch("https://openrouter.test", request);
    const stream = await firstCall();
    stream?.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    const reading = settled(readAll(await answer));
    // The model thinks after its role chunk; the comments keep it alive.
    await keepAlive(stream, 150);
    stream?.write('data: {"choices":[{"delta":{"content":"Да"}}]}\n\n');
    // Then the connection dies.
    await vi.advanceTimersByTimeAsync(90_000);

    expect(await reading).toMatchObject({
      idle: true,
      name: "ModelStreamStalledError",
    });
    expect(calls).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(
      "[model] OpenRouter stream stalled mid-answer",
      { idle: true }
    );
  });

  it("counts an event split across two chunks", async () => {
    vi.stubGlobal("fetch", openRouterFetch());

    const answer = watchedModelFetch("https://openrouter.test", request);
    const stream = await firstCall();
    stream?.write("da");
    stream?.write('ta: {"choices":[]}\n\n');
    const response = await answer;
    stream?.close();

    await expect(readAll(response)).resolves.toBe('data: {"choices":[]}\n\n');
  });

  it("leaves a call the caller aborted to the caller", async () => {
    vi.stubGlobal("fetch", openRouterFetch());
    const caller = new AbortController();

    const answer = watchedModelFetch("https://openrouter.test", {
      ...request,
      signal: caller.signal,
    });
    await firstCall();
    caller.abort(new Error("turn cancelled"));

    await expect(answer).rejects.toThrow("turn cancelled");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls).toHaveLength(1);
  });

  it("lets a call that does not stream hold its headers until the answer is ready", async () => {
    const json = new Response('{"id":"gen-1"}', {
      headers: { "content-type": "application/json" },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(json);
          }, 150_000);
        })
    );
    vi.stubGlobal("fetch", fetch);

    const response = watchedModelFetch("https://openrouter.test", {
      body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash" }),
      method: "POST",
    });
    await vi.advanceTimersByTimeAsync(150_000);

    await expect(response).resolves.toBe(json);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
