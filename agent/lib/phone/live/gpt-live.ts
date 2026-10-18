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
      reject(new Error(`GPT-Live connection failed: ${event.message}`));
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
      const parsed = liveEvent.safeParse(
        JSON.parse(z.string().parse(message.data))
      );
      if (!parsed.success) return;
      const session = started.safeParse(parsed.data);
      if (session.success) {
        clearTimeout(timer);
        resolve(session.data.session.id);
      }
      options.onEvent(parsed.data);
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
