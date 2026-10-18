import type { MessageStreamEvent } from "eve/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLatestSessionHistory, withOlderHistory } from "./session-history";

describe("session history", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests a bounded tail and keeps only the latest four message turns", async () => {
    const events = Array.from({ length: 6 }, (_, index) =>
      receivedMessage(index)
    );
    const fetchMock = vi.fn<() => Promise<Response>>(() =>
      Promise.resolve(
        new Response(events.map((event) => JSON.stringify(event)).join("\n"), {
          headers: { "x-eve-stream-tail-index": "5" },
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const history = await readLatestSessionHistory("session/one");

    expect(fetchMock).toHaveBeenCalledWith(
      "/eve/v1/session/session%2Fone/stream?startIndex=-128&includeTailIndex=1",
      expect.objectContaining({ cache: "no-store" })
    );
    expect(history).toEqual({
      endIndex: 6,
      events: events.slice(2),
      startIndex: 2,
    });
  });

  it("reads back through long turns in a few growing reads", async () => {
    // Ten turns of a received message and 299 streamed deltas each.
    const events = Array.from({ length: 3000 }, (_, index) =>
      index % 300 === 0 ? receivedMessage(index) : appendedDelta(index)
    );
    const fetchMock = vi.fn<
      (input: string | URL | Request) => Promise<Response>
    >((input) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
        "http://localhost"
      );
      const asked = Number(url.searchParams.get("startIndex"));
      const start = asked < 0 ? events.length + asked : asked;
      // eve streams from the cursor to the tail.
      return Promise.resolve(
        new Response(
          events
            .slice(start)
            .map((event) => JSON.stringify(event))
            .join("\n"),
          {
            headers: {
              "x-eve-stream-tail-index": String(events.length - 1),
              "x-eve-stream-version": "25",
            },
          }
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const history = await readLatestSessionHistory("long-turns");

    expect(history.startIndex).toBe(1800);
    expect(history.events).toEqual(events.slice(1800));
    // One read per 128 events took ten.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("shows an older page once, though it was read twice", () => {
    const events = Array.from({ length: 6 }, (_, index) =>
      receivedMessage(index)
    );
    const latest = { endIndex: 6, events: events.slice(4), startIndex: 4 };
    const older = { endIndex: 4, events: events.slice(2, 4), startIndex: 2 };

    const once = withOlderHistory(latest, older);
    // The second read started before the first one's page reached the state.
    const twice = withOlderHistory(once, older);

    expect(twice).toBe(once);
    expect(twice.events).toEqual(events.slice(2));
  });

  it("rejects a stream response without a durable tail cursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(() => Promise.resolve(new Response("\n")))
    );

    await expect(readLatestSessionHistory("missing-tail")).rejects.toThrow(
      "valid tail index"
    );
  });
});

function receivedMessage(index: number): MessageStreamEvent {
  return {
    data: {
      message: `Message ${String(index)}`,
      sequence: index,
      turnId: `turn_${String(index)}`,
    },
    meta: {
      at: new Date(index * 1000).toISOString(),
      id: `event_${String(index)}`,
    },
    type: "message.received",
  };
}

function appendedDelta(index: number): MessageStreamEvent {
  return {
    data: {
      messageDelta: "слово ",
      sequence: index,
      stepIndex: 0,
      turnId: `turn_${String(index - (index % 300))}`,
    },
    meta: {
      at: new Date(index * 1000).toISOString(),
      id: `event_${String(index)}`,
    },
    type: "message.appended",
  };
}
