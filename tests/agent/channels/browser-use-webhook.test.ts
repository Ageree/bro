import { createHmac } from "node:crypto";
import type { RouteHandlerArgs } from "eve/channels";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserRunDelivery } from "@agent/lib/browser-use/completion";

const secret = "browser-use-webhook-secret";
const runId = "11111111-1111-4111-8111-111111111111";

const settleBrowserRun = vi.hoisted(() =>
  vi.fn<(delivery: BrowserRunDelivery, id: string) => Promise<void>>(() =>
    Promise.resolve()
  )
);
const readBrowserRun = vi.hoisted(() =>
  vi.fn<(id: string) => Promise<{ id: string } | undefined>>((id) =>
    Promise.resolve(id === runId ? { id } : undefined)
  )
);

vi.mock("@agent/lib/browser-use/completion", () => ({
  expireBrowserRun: vi.fn<() => Promise<void>>(),
  settleBrowserRun,
}));
const listOpenBrowserRunIdsInSession = vi.hoisted(() =>
  vi.fn<(sessionId: string) => Promise<string[]>>((sessionId) =>
    Promise.resolve(sessionId === "cloud-session" ? [runId] : [])
  )
);
vi.mock("@db/services/browser-runs", () => ({
  listOpenBrowserRunIdsInSession,
  readBrowserRun,
}));

afterEach(() => {
  // Clearing every stub would also drop the values tests/setup-env.ts installs.
  vi.stubEnv("BROWSER_USE_WEBHOOK_SECRET", "");
  vi.clearAllMocks();
  vi.resetModules();
});

async function loadRoute(webhookSecret: string | undefined) {
  vi.resetModules();
  vi.stubEnv("BROWSER_USE_WEBHOOK_SECRET", webhookSecret ?? "");
  const channel = await import("@agent/channels/browser-use");
  const route = channel.default.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" &&
      candidate.path === "/eve/v1/browser-use"
  );
  if (!route || route.transport === "websocket") {
    throw new Error("The Browser Use webhook route is unavailable.");
  }
  return { canonical: channel.canonicalWebhookPayload, handler: route.handler };
}

function deliver(
  handler: Awaited<ReturnType<typeof loadRoute>>["handler"],
  options: {
    readonly body: string;
    readonly signature: string;
    readonly timestamp: string;
  }
) {
  const pending: Promise<unknown>[] = [];
  const context = {
    attachSession: () => {
      throw new Error("The webhook must not attach a session directly.");
    },
    from: unavailable,
    params: {},
    requestIp: null,
    resolveSession: unavailable,
    to: unavailable,
    waitUntil: (task: Promise<unknown>) => pending.push(task),
  } satisfies RouteHandlerArgs;
  const response = handler(
    new Request("https://assistant.example/eve/v1/browser-use", {
      body: options.body,
      headers: {
        "content-type": "application/json",
        "x-browser-use-signature": options.signature,
        "x-browser-use-timestamp": options.timestamp,
      },
      method: "POST",
    }),
    context
  );
  return { pending, response };
}

function unavailable(): never {
  throw new Error("The webhook route does not use this operation.");
}

function sign(canonical: string, timestamp: string, signingSecret: string) {
  return createHmac("sha256", signingSecret)
    .update(`${timestamp}.${canonical}`, "utf8")
    .digest("hex");
}

function terminalEvent(id: string) {
  return {
    payload: { run_id: id, status: "completed" },
    type: "session.status.update",
  };
}

function nowSeconds() {
  return String(Math.floor(Date.now() / 1_000));
}

describe("Browser Use webhook", () => {
  it("canonicalizes the event the way the sender signs it", async () => {
    const { canonical } = await loadRoute(secret);
    expect(
      canonical({
        type: "session.status.update",
        payload: { status: "idle", city: "München" },
        timestamp: "2026-09-09T12:00:00Z",
      })
    ).toBe(
      '{"payload":{"city":"M\\u00fcnchen","status":"idle"},"timestamp":"2026-09-09T12:00:00Z","type":"session.status.update"}'
    );
  });

  it("settles a run on a verified terminal delivery", async () => {
    const { canonical, handler } = await loadRoute(secret);
    const event = terminalEvent(runId);
    const timestamp = nowSeconds();
    const { pending, response } = deliver(handler, {
      body: JSON.stringify(event),
      signature: sign(canonical(event), timestamp, secret),
      timestamp,
    });

    expect((await response).status).toBe(200);
    await Promise.all(pending);
    expect(settleBrowserRun).toHaveBeenCalledWith(expect.anything(), runId);
  });

  it("settles the open run of a session a session event names", async () => {
    const { canonical, handler } = await loadRoute(secret);
    const event = {
      payload: { session_id: "cloud-session", status: "idle" },
      type: "session.status.update",
    };
    const timestamp = nowSeconds();
    const { pending, response } = deliver(handler, {
      body: JSON.stringify(event),
      signature: sign(canonical(event), timestamp, secret),
      timestamp,
    });

    expect((await response).status).toBe(200);
    await Promise.all(pending);
    expect(settleBrowserRun).toHaveBeenCalledWith(expect.anything(), runId);
  });

  it("ignores a run this deployment never started", async () => {
    const { canonical, handler } = await loadRoute(secret);
    const event = terminalEvent("someone-elses-run");
    const timestamp = nowSeconds();
    const { pending, response } = deliver(handler, {
      body: JSON.stringify(event),
      signature: sign(canonical(event), timestamp, secret),
      timestamp,
    });

    expect((await response).status).toBe(200);
    await Promise.all(pending);
    expect(settleBrowserRun).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret, a stale timestamp and an unconfigured deployment", async () => {
    const { canonical, handler } = await loadRoute(secret);
    const event = terminalEvent(runId);
    const body = JSON.stringify(event);
    const timestamp = nowSeconds();
    const stale = String(Number(timestamp) - 600);

    const wrongSecret = await deliver(handler, {
      body,
      signature: sign(canonical(event), timestamp, "not-the-secret"),
      timestamp,
    }).response;
    const staleDelivery = await deliver(handler, {
      body,
      signature: sign(canonical(event), stale, secret),
      timestamp: stale,
    }).response;

    const unconfigured = await loadRoute(undefined);
    const unconfiguredDelivery = await deliver(unconfigured.handler, {
      body,
      signature: sign(canonical(event), timestamp, secret),
      timestamp,
    }).response;

    expect(wrongSecret.status).toBe(401);
    expect(staleDelivery.status).toBe(401);
    expect(unconfiguredDelivery.status).toBe(401);
    expect(settleBrowserRun).not.toHaveBeenCalled();
  });
});
