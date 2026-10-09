import type { RouteHandlerArgs } from "eve/channels";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OpenedHandoff,
  ownsLoginHandoff,
} from "@agent/lib/login-handoff/open";
import type { settleLoginHandoff } from "@agent/lib/login-handoff/settle";
import { handoffRow } from "@tests/helpers/login-handoff";
import type { readBrowserVm } from "@db/services/browser-vms";
import type {
  endLoginHandoff,
  readLoginHandoff,
} from "@db/services/login-handoffs";
import type * as workerModule from "@agent/lib/browser-vm/worker";

vi.hoisted(() => {
  vi.stubEnv("LOGIN_HANDOFF_WORKSPACES", "*");
  vi.stubEnv("BETTER_AUTH_URL", "https://bro.example.test");
});

const services = vi.hoisted(() => ({
  cancel: vi.fn<typeof workerModule.cancelBrowserVmWorkerHandoff>(),
  end: vi.fn<typeof endLoginHandoff>(),
  open: vi.fn<(...input: unknown[]) => Promise<OpenedHandoff>>(),
  owns: vi.fn<typeof ownsLoginHandoff>(),
  read: vi.fn<typeof readLoginHandoff>(),
  readVm: vi.fn<typeof readBrowserVm>(),
  save: vi.fn<(workspaceId: string, now: Date) => Promise<void>>(),
  settle: vi.fn<typeof settleLoginHandoff>(),
}));

vi.mock("@agent/lib/browser-vm/worker", () => ({
  cancelBrowserVmWorkerHandoff: services.cancel,
}));
vi.mock("@agent/lib/login-handoff/open", () => ({
  newDeviceSecret: () => "new-device-secret",
  openLoginHandoff: services.open,
  ownsLoginHandoff: services.owns,
}));
vi.mock("@agent/lib/login-handoff/settle", () => ({
  saveProfileSoon: services.save,
  settleLoginHandoff: services.settle,
}));
vi.mock("@db/services/browser-vms", () => ({ readBrowserVm: services.readVm }));
vi.mock("@db/services/login-handoffs", () => ({
  endLoginHandoff: services.end,
  readLoginHandoff: services.read,
}));

import channel from "@agent/channels/login-handoff";

const origin = "https://bro.example.test";
const claimed = handoffRow({
  deviceHash: "x",
  expiresAt: new Date(Date.now() + 600_000),
});

async function call(
  method: "GET" | "POST",
  path: string,
  headers: Readonly<Record<string, string>> = {}
) {
  const pattern = `/eve/v1/login-handoff/:id${path}`;
  const route = channel.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" &&
      candidate.method === method &&
      candidate.path === pattern
  );
  if (!route || route.transport === "websocket") {
    throw new Error(`Expected ${method} ${pattern}.`);
  }
  const url = `${origin}/eve/v1/login-handoff/link-1${path}`;
  return await route.handler(
    new Request(url, { headers, method }),
    routeContext({ id: "link-1" })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  services.read.mockResolvedValue(claimed);
  services.owns.mockResolvedValue(true);
  services.readVm.mockResolvedValue(undefined);
});

describe("the sign-in window's routes", () => {
  it("shows the page what it needs and takes nothing by a plain read", async () => {
    const response = await call("GET", "");
    expect(await response.json()).toMatchObject({
      domain: "ozon.ru",
      mine: false,
      state: "claimed",
    });
    expect(services.open).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("says nothing of a link that is not there", async () => {
    services.read.mockResolvedValue(undefined);
    expect((await call("GET", "")).status).toBe(404);
  });

  it("takes the link only from the page itself, and gives the first device a cookie of its own", async () => {
    services.open.mockResolvedValue({ kind: "starting", retryAfterMs: 5_000 });
    expect((await call("POST", "/open")).status).toBe(404);
    expect(
      (await call("POST", "/open", { origin: "https://evil.test" })).status
    ).toBe(404);
    expect(services.open).not.toHaveBeenCalled();
    const response = await call("POST", "/open", { origin });
    expect(await response.json()).toEqual({
      kind: "starting",
      retryAfterMs: 5_000,
    });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("bro_handoff=new-device-secret");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/eve/v1/login-handoff/link-1");
    expect(services.open).toHaveBeenCalledWith({
      deviceSecret: "new-device-secret",
      id: "link-1",
    });
  });

  it("keeps the device the same when it comes back, with no new cookie", async () => {
    services.open.mockResolvedValue({ kind: "busy" });
    const response = await call("POST", "/open", {
      cookie: "bro_handoff=old-secret",
      origin,
    });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(services.open).toHaveBeenCalledWith({
      deviceSecret: "old-secret",
      id: "link-1",
    });
  });

  it("lets only the device that took the link finish or cancel it", async () => {
    services.owns.mockResolvedValue(false);
    for (const path of ["/finish", "/cancel"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each route is its own request.
      const response = await call("POST", path, {
        cookie: "bro_handoff=other",
        origin,
      });
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
    }
    expect((await call("POST", "/finish", { origin })).status).toBe(404);
    expect(services.settle).not.toHaveBeenCalled();
    expect(services.end).not.toHaveBeenCalled();
  });

  it("finishes by reading the worker, and answers with how it ended", async () => {
    services.read
      .mockResolvedValueOnce(claimed)
      .mockResolvedValueOnce({ ...claimed, signedIn: true, state: "done" });
    const response = await call("POST", "/finish", {
      cookie: "bro_handoff=secret",
      origin,
    });
    expect(services.settle).toHaveBeenCalledWith(claimed);
    expect(await response.json()).toEqual({ signedIn: true, state: "done" });
  });

  it("cancels on the worker and ends without a word", async () => {
    // SAFETY: the route reads only the host of the VM record.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stored row stands in.
    services.readVm.mockResolvedValue({ host: "203.0.113.5" } as never);
    services.cancel.mockResolvedValue(undefined);
    const response = await call("POST", "/cancel", {
      cookie: "bro_handoff=secret",
      origin,
    });
    expect(services.cancel).toHaveBeenCalledWith(
      { host: "203.0.113.5" },
      "h_worker"
    );
    expect(services.end).toHaveBeenCalledWith(
      "link-1",
      { report: null, state: "cancelled" },
      expect.any(Date)
    );
    expect(await response.json()).toEqual({ state: "cancelled" });
  });
});

function routeContext(params: Readonly<Record<string, string>>) {
  return {
    attachSession: unexpected,
    from: unexpected,
    params,
    requestIp: null,
    resolveSession: unexpected,
    to: unexpected,
    waitUntil: unexpected,
  } satisfies RouteHandlerArgs;
}

function unexpected(): never {
  throw new Error("The sign-in window routes start no session.");
}
