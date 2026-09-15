import { assert, eq } from "./lib/check.ts";
import {
  cancelRun,
  hydrate,
  queueMessage,
  resolveQueuedRun,
  sessionInfo,
  stopBrowserForSession,
} from "../agent/lib/browseruse.ts";

// Behavioral check: prove the follow-up path actually hits the v4
// POST /sessions/{id}/queue endpoint with the right body, reads session
// status back, and resolves the run to follow. Pure-policy tests cannot see
// this wiring — the missing /queue call is exactly how the "code never lands
// in the live tab" bug shipped green.

type Call = { url: string; method: string; body: unknown; apiKey?: string };

function withFetch(
  routes: (call: Call) => { status?: number; json: unknown } | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers ?? {});
    const call: Call = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body:
        typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined,
      apiKey: headers.get("X-Browser-Use-API-Key") ?? undefined,
    };
    calls.push(call);
    const hit = routes(call);
    if (!hit) throw new Error(`unexpected fetch: ${call.method} ${url}`);
    return new Response(JSON.stringify(hit.json), {
      status: hit.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  (globalThis as { __calls?: Call[] }).__calls = calls;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

function lastCalls(): Call[] {
  return (globalThis as { __calls?: Call[] }).__calls ?? [];
}

process.env.BROWSER_USE_API_KEY = "test-key";

await withFetch(
  (call) => {
    if (call.method === "POST" && call.url.endsWith("/sessions/sess-1/queue")) {
      return {
        json: {
          id: 7,
          sessionId: "sess-1",
          runId: "run-2",
          mode: "queue",
          status: "pending",
        },
      };
    }
    return undefined;
  },
  async () => {
    const q = await queueMessage("sess-1", "Одноразовый код: 482911", {
      interrupt: false,
    });
    const calls = lastCalls();
    eq(calls.length, 1, "queue makes one call");
    const c = calls[0]!;
    assert(
      c.url === "https://api.browser-use.com/api/v4/sessions/sess-1/queue",
      "queue hits the v4 session queue endpoint",
    );
    eq(c.method, "POST", "queue is a POST");
    eq(c.apiKey, "test-key", "queue sends the API key");
    const body = c.body as { text?: string; interrupt?: boolean };
    eq(body.text, "Одноразовый код: 482911", "queue sends the exact text");
    assert(!("interrupt" in (c.body as object)), "interrupt:false is omitted");
    eq(q.runId, "run-2", "queue parses the new runId");
    eq(q.status, "pending", "queue parses status");
    eq(q.mode, "queue", "queue parses mode");
  },
);

// interrupt:true is forwarded so a correction preempts the active run.
await withFetch(
  (call) =>
    call.url.endsWith("/sessions/sess-1/queue")
      ? { json: { id: 8, sessionId: "sess-1", runId: "run-3", status: "pending" } }
      : undefined,
  async () => {
    await queueMessage("sess-1", "не туда, Ленина 12", { interrupt: true });
    const body = lastCalls()[0]!.body as { interrupt?: boolean };
    eq(body.interrupt, true, "interrupt:true is forwarded");
  },
);

// Empty text never reaches the network.
{
  let threw = false;
  try {
    await queueMessage("sess-1", "   ");
  } catch {
    threw = true;
  }
  assert(threw, "empty queue text throws before fetch");
}

// sessionInfo reads status + latest run id (camel and snake case).
await withFetch(
  (call) =>
    call.url.endsWith("/sessions/sess-1")
      ? {
          json: {
            sessionId: "sess-1",
            status: "running",
            latestRunId: "run-2",
          },
        }
      : undefined,
  async () => {
    const info = await sessionInfo("sess-1");
    assert(info !== undefined, "sessionInfo returns");
    eq(info!.status, "running", "sessionInfo reads status");
    eq(info!.latestRunId, "run-2", "sessionInfo reads latestRunId");
  },
);

// resolveQueuedRun: a fresh runId from the queue is used without polling.
await withFetch(
  () => ({ json: {} }),
  async () => {
    const r = await resolveQueuedRun(
      "sess-1",
      "run-1",
      { runId: "run-2", status: "pending" },
    );
    eq(r.runId, "run-2", "new queued runId is followed");
    eq(lastCalls().length, 0, "no session poll needed when runId is fresh");
  },
);

// resolveQueuedRun: when the queue gives no new runId, poll the session and
// follow the run once it goes active (same run resumed).
await withFetch(
  (call) =>
    call.url.endsWith("/sessions/sess-1")
      ? { json: { sessionId: "sess-1", status: "running", latestRunId: "run-1" } }
      : undefined,
  async () => {
    const r = await resolveQueuedRun(
      "sess-1",
      "run-1",
      { runId: "run-1", status: "completed" },
      { ms: 5_000, nowFn: () => 0 },
    );
    eq(r.runId, "run-1", "resumed run is followed once active");
    eq(r.status, "running", "resumed run status is read");
    assert(lastCalls().length >= 1, "session was polled");
  },
);

// resolveQueuedRun: give up after the window and fall back to latest/queued.
await withFetch(
  (call) =>
    call.url.endsWith("/sessions/sess-1")
      ? { json: { sessionId: "sess-1", status: "completed", latestRunId: "run-1" } }
      : undefined,
  async () => {
    let t = 0;
    const r = await resolveQueuedRun(
      "sess-1",
      "run-1",
      { runId: "run-1", status: "completed" },
      { ms: 6_000, nowFn: () => (t === 0 ? (t = 1, 0) : 7_000) },
    );
    eq(r.runId, "run-1", "falls back to latest run id");
  },
);

// cancelRun: POST /runs/{id}/cancel, idempotent (404 swallowed as success).
await withFetch(
  (call) =>
    call.method === "POST" && call.url.endsWith("/runs/run-1/cancel")
      ? { json: { id: "run-1", status: "cancelled" } }
      : undefined,
  async () => {
    const ok = await cancelRun("run-1");
    eq(ok, true, "cancelRun reports success");
    const calls = lastCalls();
    eq(calls.length, 1, "cancelRun makes one call");
    eq(calls[0]!.method, "POST", "cancel is a POST");
    assert(
      calls[0]!.url === "https://api.browser-use.com/api/v4/runs/run-1/cancel",
      "cancel hits the v4 cancel-run endpoint",
    );
  },
);
await withFetch(
  (call) =>
    call.url.endsWith("/runs/gone/cancel")
      ? { status: 404, json: { error: "not found" } }
      : undefined,
  async () => {
    const ok = await cancelRun("gone");
    eq(ok, true, "a 404 (already gone) is treated as a successful cancel");
  },
);
await withFetch(
  (call) =>
    call.url.endsWith("/runs/boom/cancel")
      ? { status: 500, json: { error: "control plane unreachable" } }
      : undefined,
  async () => {
    const ok = await cancelRun("boom");
    eq(ok, false, "a real failure is reported, never thrown");
  },
);

// stopBrowserForSession: GET /browsers → match by session → PATCH stop.
await withFetch(
  (call) => {
    if (call.method === "GET" && call.url.endsWith("/browsers")) {
      return {
        json: {
          items: [
            { id: "b1", agentSessionId: "sess-1", liveUrl: "https://live/x", cdpUrl: "https://cdp/x" },
          ],
        },
      };
    }
    if (call.method === "PATCH" && call.url.endsWith("/browsers/b1")) {
      return { json: { id: "b1", status: "stopped" } };
    }
    return undefined;
  },
  async () => {
    const ok = await stopBrowserForSession("sess-1");
    eq(ok, true, "stopBrowserForSession stops the matched browser");
    const calls = lastCalls();
    eq(calls.length, 2, "list then patch");
    const patch = calls.find((c) => c.method === "PATCH");
    assert(patch !== undefined, "a PATCH call was made");
    assert(
      JSON.stringify(patch!.body) === JSON.stringify({ action: "stop" }),
      "stop body is exactly action:stop",
    );
  },
);
await withFetch(
  (call) =>
    call.url.endsWith("/browsers") ? { json: { items: [] } } : undefined,
  async () => {
    const ok = await stopBrowserForSession("sess-missing");
    eq(ok, false, "no matching browser → best-effort false, no throw");
  },
);

// hydrate: a 500 on GET /runs/{id} degrades to "unknown", never throws.
await withFetch(
  (call) =>
    call.url.endsWith("/runs/run-flaky")
      ? { status: 500, json: { error: "boom" } }
      : undefined,
  async () => {
    const run = await hydrate("run-flaky", "sess-1");
    eq(run.status, "unknown", "hydrate degrades to unknown on a fetch failure");
    eq(run.runId, "run-flaky", "hydrate keeps the runId on failure");
    eq(run.sessionId, "sess-1", "hydrate keeps the last-known sessionId on failure");
    eq(lastCalls().length, 1, "no enrichment calls are made after the primary fetch fails");
  },
);

// hydrate: the result is scrubbed of PAN/CVV/password before it comes back.
await withFetch(
  (call) => {
    if (call.url.endsWith("/runs/run-pay")) {
      return {
        json: {
          id: "run-pay",
          status: "completed",
          result: "Оплатил картой 4111 1111 1111 1111, пароль: hunter2, cvv 123",
        },
      };
    }
    if (call.url.includes("/runs/run-pay/events")) return { json: { events: [] } };
    if (call.url.endsWith("/browsers")) return { json: { items: [] } };
    return undefined;
  },
  async () => {
    const run = await hydrate("run-pay");
    assert(run.result !== undefined, "result is present");
    assert(!run.result!.includes("4111"), "card number is scrubbed from the result");
    assert(!run.result!.includes("hunter2"), "password is scrubbed from the result");
    assert(!run.result!.includes("123"), "cvv is scrubbed from the result");
    assert(run.result!.includes("[card]"), "card is replaced with a marker");
    assert(run.result!.includes("[password]"), "password is replaced with a marker");
    assert(run.result!.includes("[cvv]"), "cvv is replaced with a marker");
  },
);

console.log("browser-queue-check ok");
