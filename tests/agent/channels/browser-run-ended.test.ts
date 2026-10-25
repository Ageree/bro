import { createHmac } from "node:crypto";
import type { RouteHandlerArgs } from "eve/channels";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserRunDelivery } from "@agent/lib/browser-use/completion";
import {
  browserVmTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "../../helpers/browser-vm";

const workspaceId = "personal:abc";
const runId = `vm:${workspaceId}:r:11111111-1111-4111-8111-111111111111`;

const settleBrowserRun = vi.hoisted(() =>
  vi.fn<
    (delivery: BrowserRunDelivery, id: string) => Promise<{ kind: string }>
  >(() => Promise.resolve({ kind: "closed" }))
);
const readBrowserRun = vi.hoisted(() =>
  vi.fn<(id: string) => Promise<{ id: string } | undefined>>((id) =>
    Promise.resolve({ id })
  )
);

vi.mock("@agent/lib/browser-use/completion", () => ({ settleBrowserRun }));
vi.mock("@db/services/browser-runs", () => ({ readBrowserRun }));

afterEach(() => {
  clearBrowserVmSettings();
  vi.clearAllMocks();
  vi.resetModules();
});

/** What the worker computes (`notify_ended`): the VM's key, derived from the signing key, over the run's name. */
function workerSignature(id: string, workspace = workspaceId) {
  const key = createHmac(
    "sha256",
    Buffer.from(browserVmTestEnvironment.BROWSER_VM_SIGNING_KEY, "hex")
  )
    .update(`bro-browser-vm:${workspace}`)
    .digest();
  return createHmac("sha256", key).update(`run-ended.${id}`).digest("hex");
}

async function loadRoute(settings: Record<string, string>) {
  vi.resetModules();
  const channel = await importWithSettings(
    { ...browserVmTestEnvironment, ...settings },
    async () => import("@agent/channels/browser-run-ended")
  );
  const route = channel.default.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" &&
      candidate.path === "/eve/v1/browser-run-ended"
  );
  if (!route || route.transport === "websocket") {
    throw new Error("The browser run ended route is unavailable.");
  }
  return route.handler;
}

function deliver(
  handler: Awaited<ReturnType<typeof loadRoute>>,
  options: { readonly body: string; readonly signature?: string }
) {
  const pending: Promise<unknown>[] = [];
  const context = {
    attachSession: () => {
      throw new Error("The route must not attach a session directly.");
    },
    from: unavailable,
    params: {},
    requestIp: null,
    resolveSession: unavailable,
    to: unavailable,
    waitUntil: (task: Promise<unknown>) => pending.push(task),
  } satisfies RouteHandlerArgs;
  const headers = new Headers({ "content-type": "application/json" });
  if (options.signature !== undefined) {
    headers.set("x-bro-signature", options.signature);
  }
  const response = handler(
    new Request("https://assistant.example/eve/v1/browser-run-ended", {
      body: options.body,
      headers,
      method: "POST",
    }),
    context
  );
  return { pending, response };
}

function unavailable(): never {
  throw new Error("The route does not use this operation.");
}

const body = (id: string) => JSON.stringify({ runId: id, status: "completed" });

describe("the worker's word that a browser run ended", () => {
  it("settles the run at once when the VM's worker signs it", async () => {
    const handler = await loadRoute({
      BROWSER_FAST_DELIVERY_WORKSPACES: workspaceId,
    });
    const { pending, response } = deliver(handler, {
      body: body(runId),
      signature: workerSignature(runId),
    });

    expect((await response).status).toBe(202);
    await Promise.all(pending);
    expect(settleBrowserRun).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      runId
    );
  });

  it("refuses a word that is unsigned, signed with another VM's key or about a run that is not on a VM", async () => {
    const handler = await loadRoute({ BROWSER_FAST_DELIVERY_WORKSPACES: "*" });
    const other = `vm:personal:other:r:11111111-1111-4111-8111-111111111111`;
    const cases = [
      { body: body(runId) },
      { body: body(runId), signature: "0".repeat(64) },
      { body: body(runId), signature: "not hex" },
      // The key of the VM of a workspace the run does not belong to.
      {
        body: body(runId),
        signature: workerSignature(runId, "personal:other"),
      },
      // A signature of another run's name.
      { body: body(runId), signature: workerSignature(other) },
      {
        body: body("11111111-1111-4111-8111-111111111111"),
        signature: workerSignature("11111111-1111-4111-8111-111111111111"),
      },
      { body: "not json", signature: workerSignature(runId) },
    ];
    for (const attempt of cases) {
      const { pending, response } = deliver(handler, attempt);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each attempt is checked before the next.
      expect((await response).status).toBe(401);
      expect(pending).toHaveLength(0);
    }
    expect(settleBrowserRun).not.toHaveBeenCalled();
  });

  it("does nothing for a workspace outside the fast delivery pilot or a run Bro has no record of", async () => {
    const outside = await loadRoute({
      BROWSER_FAST_DELIVERY_WORKSPACES: "personal:another",
    });
    const unlisted = deliver(outside, {
      body: body(runId),
      signature: workerSignature(runId),
    });
    expect((await unlisted.response).status).toBe(202);
    expect(unlisted.pending).toHaveLength(0);

    const inside = await loadRoute({ BROWSER_FAST_DELIVERY_WORKSPACES: "*" });
    readBrowserRun.mockResolvedValueOnce(undefined);
    const unknown = deliver(inside, {
      body: body(runId),
      signature: workerSignature(runId),
    });
    expect((await unknown.response).status).toBe(202);
    expect(unknown.pending).toHaveLength(0);
    expect(settleBrowserRun).not.toHaveBeenCalled();
  });

  it("does not let a settle that fails escape the route", async () => {
    const handler = await loadRoute({ BROWSER_FAST_DELIVERY_WORKSPACES: "*" });
    settleBrowserRun.mockRejectedValueOnce(new Error("the worker is gone"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { pending, response } = deliver(handler, {
      body: body(runId),
      signature: workerSignature(runId),
    });

    expect((await response).status).toBe(202);
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      "[browser-use] a run's end could not be settled",
      expect.objectContaining({ runId })
    );
  });
});
