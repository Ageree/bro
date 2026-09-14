import {
  cdpCurrentUrl,
  listCdpTargets,
  pickCdpPage,
} from "../../convex/lib/browserCdp.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type CdpReply = {
  id?: number;
  error?: { message?: string };
};

/**
 * Open `target` in the Cloud browser tab. Does not wait for the Cloud LLM.
 * Returns the tab URL after navigate (may still be about:blank on failure).
 */
export async function cdpNavigate(
  cdpUrl: string,
  target: string,
  ms = 20_000,
): Promise<string | undefined> {
  const targets = await listCdpTargets(cdpUrl);
  const page = pickCdpPage(targets);
  const wsUrl = page?.webSocketDebuggerUrl?.trim();
  if (!wsUrl) throw new Error("cdp page missing websocket");

  const ws = new WebSocket(wsUrl);
  const pending = new Map<number, (reply: CdpReply) => void>();
  let nextId = 1;

  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cdp websocket timeout")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("cdp websocket error"));
    });
  });

  ws.addEventListener("message", (ev) => {
    let reply: CdpReply;
    try {
      reply = JSON.parse(String(ev.data)) as CdpReply;
    } catch {
      return;
    }
    if (typeof reply.id !== "number") return;
    const wait = pending.get(reply.id);
    if (!wait) return;
    pending.delete(reply.id);
    wait(reply);
  });

  await opened;

  const call = async (
    method: string,
    params?: Record<string, string>,
  ): Promise<void> => {
    const id = nextId++;
    const reply = await new Promise<CdpReply>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cdp ${method} timeout`)), 15_000);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
    if (reply.error?.message) throw new Error(`cdp ${method}: ${reply.error.message}`);
  };

  try {
    await call("Page.enable");
    await call("Page.navigate", { url: target });
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const url = cdpCurrentUrl(await listCdpTargets(cdpUrl));
      if (url && url !== "about:blank" && !url.startsWith("chrome-error://")) {
        return url;
      }
      await sleep(400);
    }
    return cdpCurrentUrl(await listCdpTargets(cdpUrl));
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

export { cdpPageUrl } from "../../convex/lib/browserCdp.ts";
