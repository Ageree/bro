import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";

/**
 * A stand-in for eve's session routes, just enough for the real
 * `eve/client` the driver uses: create, send, respond, and the NDJSON stream
 * with its version header. Each POST appends the batch of events the test
 * scripts for it; `append` adds events nobody asked for, as a background
 * turn would.
 */

const sessionId = "wrun_fake";

const postBodySchema = z.object({
  inputResponses: z
    .array(
      z.object({
        optionId: z.string().optional(),
        requestId: z.string(),
        text: z.string().optional(),
      })
    )
    .optional(),
  message: z.union([z.string(), z.array(z.looseObject({}))]).optional(),
});

export type FakePost = z.infer<typeof postBodySchema> & {
  readonly route: "create" | "session";
};

export async function startFakeEve(
  reply: (post: FakePost) => readonly MessageStreamEvent[]
) {
  const events: MessageStreamEvent[] = [];
  const posts: FakePost[] = [];
  let deliveries = 0;

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fake.invalid");
      const json = (
        status: number,
        body: Readonly<Record<string, string | boolean>>
      ) => {
        response.writeHead(status, {
          "content-type": "application/json",
          "x-eve-session-id": sessionId,
        });
        response.end(JSON.stringify(body));
      };
      if (url.pathname === "/eve/v1/health") {
        json(200, { ok: true, status: "ready", workflowId: "wf_fake" });
        return;
      }
      if (request.method === "POST") {
        const body = postBodySchema.parse(JSON.parse(await text(request)));
        const route = url.pathname === "/eve/v1/session" ? "create" : "session";
        const post = { ...body, route } as const;
        posts.push(post);
        const deliveryId =
          route === "session" && body.message !== undefined
            ? `delivery_${String((deliveries += 1))}`
            : undefined;
        for (const event of reply(post)) {
          events.push(
            deliveryId
              ? { ...event, meta: { ...event.meta, deliveryIds: [deliveryId] } }
              : event
          );
        }
        json(202, deliveryId ? { deliveryId, sessionId } : { sessionId });
        return;
      }
      if (url.pathname === `/eve/v1/session/${sessionId}/stream`) {
        const start = Number(url.searchParams.get("startIndex") ?? "0");
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "x-eve-stream-tail-index": String(events.length - 1),
          "x-eve-stream-version": "25",
        });
        response.end(
          events
            .slice(start)
            .map((event) => `${JSON.stringify(event)}\n`)
            .join("")
        );
        return;
      }
      json(404, { error: "not found" });
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = z.object({ port: z.number() }).parse(server.address());

  return {
    append(batch: readonly MessageStreamEvent[]) {
      events.push(...batch);
    },
    close() {
      server.closeAllConnections();
      return new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
    events,
    posts,
    url: `http://127.0.0.1:${String(port)}`,
  };
}
