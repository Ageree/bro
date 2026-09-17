/**
 * Minimal CDP client for *independent* outcome verification in the nav benchmark.
 *
 * Both benchmark arms are graded the same way: attach to whatever browser the
 * agent actually drove, evaluate the task's predicate in the final page, and
 * believe only that. Neither arm's own report is trusted — jev-ultrafast's
 * AGENTS.md says it outright ("A DONE choice is not proof of success"), and a
 * Cloud agent's prose summary is a claim about the page, not the page.
 *
 * Deliberately no dependency: Node 22 ships a native WebSocket, and a browser
 * benchmark that pulls in a driver would start measuring the driver.
 */

export type CdpTarget = {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
};

/** ws(s):// -> http(s):// for the /json discovery endpoints. */
export function httpBase(cdpUrl: string): string {
  return cdpUrl.trim().replace(/\/+$/, "")
    .replace(/^ws:/i, "http:")
    .replace(/^wss:/i, "https:");
}

/**
 * A localhost CDP endpoint must never go through the agent proxy: the proxy
 * answers for it and the handshake dies with a 403 that looks like a dead
 * browser. Node's fetch ignores *_PROXY unless asked, but being explicit
 * keeps this true whoever runs it.
 */
function isLoopback(url: string): boolean {
  try {
    const h = new URL(httpBase(url)).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

export async function listTargets(cdpUrl: string): Promise<CdpTarget[]> {
  const res = await fetch(`${httpBase(cdpUrl)}/json/list`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`cdp /json/list -> ${res.status}`);
  const raw = await res.json();
  return (Array.isArray(raw) ? raw : []).filter(
    (t: unknown): t is CdpTarget =>
      !!t && typeof t === "object" && typeof (t as CdpTarget).id === "string",
  );
}

export async function browserWsUrl(cdpUrl: string): Promise<string> {
  // A browser-level ws URL can be handed to us directly; only a bare
  // http://host:port needs the /json/version lookup.
  if (/\/devtools\/browser\//.test(cdpUrl)) return cdpUrl;
  const res = await fetch(`${httpBase(cdpUrl)}/json/version`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`cdp /json/version -> ${res.status}`);
  const v = await res.json();
  const ws = v?.webSocketDebuggerUrl;
  if (typeof ws !== "string") throw new Error("no webSocketDebuggerUrl");
  return ws;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** One browser-level CDP connection, multiplexed over flat sessions. */
export class Cdp {
  #ws: WebSocket;
  #next = 1;
  #pending = new Map<number, Pending>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => {
      let msg: any;
      try { msg = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
      const p = typeof msg.id === "number" ? this.#pending.get(msg.id) : undefined;
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message ?? "cdp error"}`));
      else p.resolve(msg.result ?? {});
    });
    ws.addEventListener("close", () => {
      for (const p of this.#pending.values()) p.reject(new Error("cdp socket closed"));
      this.#pending.clear();
    });
  }

  static async connect(cdpUrl: string): Promise<Cdp> {
    const ws = new WebSocket(await browserWsUrl(cdpUrl));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("cdp connect timeout")), 20_000);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("cdp connect failed")); }, { once: true });
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.#next++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`cdp ${method} timeout`));
      }, 30_000);
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.#ws.send(JSON.stringify(payload));
    });
  }

  async attach(targetId: string): Promise<string> {
    const r = await this.send("Target.attachToTarget", { targetId, flatten: true });
    if (typeof r.sessionId !== "string") throw new Error("attach returned no sessionId");
    return r.sessionId;
  }

  /** Evaluate `expr` in the page and return its JSON value. */
  async evaluate(sessionId: string, expr: string): Promise<unknown> {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);
    if (r.exceptionDetails) {
      const text = r.exceptionDetails?.exception?.description ??
        r.exceptionDetails?.text ?? "evaluate threw";
      throw new Error(String(text).split("\n")[0]);
    }
    return r.result?.value;
  }

  close(): void {
    try { this.#ws.close(); } catch { /* already gone */ }
  }
}

/** Pick the page target the agent most likely ended on. */
export function pickPage(targets: readonly CdpTarget[]): CdpTarget | undefined {
  const pages = targets.filter((t) => t.type === "page");
  const real = pages.filter(
    (t) => t.url && !/^(about:|chrome:|devtools:|chrome-extension:)/i.test(t.url),
  );
  return real[real.length - 1] ?? pages[pages.length - 1];
}

export { isLoopback };
