import { ProxyAgent, WebSocket } from "undici";
import { z } from "zod";

// GPT-Live over a server WebSocket (developers.openai.com/api/docs/guides/voice-websockets?api=live): one
// `session.start`, then audio both ways as base64 in the session's format.

const liveEvent = z.looseObject({ type: z.string() });
export type LiveEvent = z.infer<typeof liveEvent>;

const started = z.object({
  type: z.literal("session.started"),
  session: z.object({ id: z.string() }),
});

function describeSocketError(event: { message: string; error?: unknown }) {
  const parts: string[] = [];
  let current: unknown = event.error;
  for (let depth = 0; current instanceof Error && depth < 3; depth += 1) {
    const code = "code" in current ? String(current.code) : "";
    parts.push(
      `${current.name}${code ? ` ${code}` : ""} ${current.message}`.trim()
    );
    current = current.cause;
  }
  return parts.join(" <- ") || event.message || "no reason given";
}

export async function openLiveSession(options: {
  apiKey: string;
  proxyUrl?: string;
  session: Record<string, z.core.util.JSONType>;
  onEvent: (event: LiveEvent) => void;
  /** How long `session.started` may take; the socket is closed when it does not come. */
  startTimeoutMs?: number;
}) {
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  const init: ConstructorParameters<typeof WebSocket>[1] = {
    headers: { Authorization: `Bearer ${options.apiKey}` },
  };
  if (options.proxyUrl) init.dispatcher = new ProxyAgent(options.proxyUrl);
  const socket = new WebSocket("wss://api.openai.com/v1/live/sessions", init);
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => {
      resolve();
    });
  });
  let opened = false;
  const sessionId = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(
        new Error(
          `GPT-Live did not start the session in ${String(startTimeoutMs / 1000)} s (${opened ? "the socket opened" : "the socket never opened"}).`
        )
      );
    }, startTimeoutMs);
    socket.addEventListener("error", (event) => {
      // undici's error event often has an empty `message`; the reason (refused tunnel, TLS, 4xx on the upgrade)
      // lives in `error` and its `cause`, and the "not ready" line of the log is the only trace of it.
      reject(
        new Error(
          `GPT-Live connection failed: ${describeSocketError(event)}`
        )
      );
    });
    socket.addEventListener("close", (event) => {
      reject(
        new Error(
          `GPT-Live closed before the session started (${String(event.code)} ${event.reason}).`
        )
      );
    });
    socket.addEventListener("open", () => {
      opened = true;
      socket.send(
        JSON.stringify({
          type: "session.start",
          event_id: "start",
          session: options.session,
        })
      );
    });
    socket.addEventListener("message", (message) => {
      // A throw in this listener would be an uncaught exception of the whole process (eve carries the calls):
      // an event that does not parse, or a handler that fails on one, is dropped and noted.
      try {
        const text = z.string().safeParse(message.data);
        if (!text.success) return;
        const parsed = liveEvent.safeParse(JSON.parse(text.data));
        if (!parsed.success) return;
        const session = started.safeParse(parsed.data);
        if (session.success) {
          clearTimeout(timer);
          resolve(session.data.session.id);
        }
        options.onEvent(parsed.data);
      } catch (error) {
        console.warn("[phone-live] a GPT-Live event was dropped", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      }
    });
  });
  return {
    sessionId,
    closed,
    send(event: Record<string, z.core.util.JSONType>) {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(event));
    },
    close() {
      socket.close();
    },
  };
}
