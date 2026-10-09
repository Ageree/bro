import { beforeEach, describe, expect, it, vi } from "vitest";
import type { usesBrowserVm } from "@agent/lib/browser-vm/backend";
import type { keepBrowserVmForErrand } from "@agent/lib/browser-vm/idle";
import type {
  ensureBrowserVm,
  prepareBrowserVmSession,
} from "@agent/lib/browser-vm/lifecycle";
import type * as workerModule from "@agent/lib/browser-vm/worker";
import type { loginHandoffs } from "@db/schema/login-handoffs";
import type {
  claimLoginHandoff,
  readLoginHandoff,
} from "@db/services/login-handoffs";

vi.hoisted(() => {
  process.env.BROWSER_VM_SIGNING_KEY = "11".repeat(32);
});

const services = vi.hoisted(() => ({
  claim: vi.fn<typeof claimLoginHandoff>(),
  ensure: vi.fn<typeof ensureBrowserVm>(),
  keep: vi.fn<typeof keepBrowserVmForErrand>(),
  open: vi.fn<typeof workerModule.openBrowserVmWorkerHandoff>(),
  prepare: vi.fn<typeof prepareBrowserVmSession>(),
  read: vi.fn<typeof readLoginHandoff>(),
  usesVm: vi.fn<typeof usesBrowserVm>(),
}));

vi.mock("@agent/lib/browser-vm/backend", () => ({
  usesBrowserVm: services.usesVm,
}));
vi.mock("@agent/lib/browser-vm/idle", () => ({
  keepBrowserVmForErrand: services.keep,
}));
vi.mock("@agent/lib/browser-vm/lifecycle", () => ({
  ensureBrowserVm: services.ensure,
  prepareBrowserVmSession: services.prepare,
}));
vi.mock("@agent/lib/browser-vm/worker", async (importOriginal) => ({
  ...(await importOriginal<typeof workerModule>()),
  openBrowserVmWorkerHandoff: services.open,
}));
vi.mock("@db/services/login-handoffs", () => ({
  claimLoginHandoff: services.claim,
  readLoginHandoff: services.read,
}));

import { BrowserVmWorkerError } from "@agent/lib/browser-vm/worker";
import {
  deviceHash,
  newDeviceSecret,
  newLinkId,
  openLoginHandoff,
  ownsLoginHandoff,
} from "@agent/lib/login-handoff/open";

type Row = typeof loginHandoffs.$inferSelect;

const now = new Date("2026-10-09T12:00:00Z");

const row = {
  allowedDomains: ["ozon.ru", "yandex.ru"],
  deviceHash: deviceHash("secret"),
  domain: "ozon.ru",
  id: "link-1",
  siteUrl: "https://www.ozon.ru/",
  viewUntil: new Date(now.getTime() + 600_000),
  workerId: "h_worker",
  workspaceId: "workspace:alice",
  createdByUserId: "alice",
  // SAFETY: the opener reads only these columns.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stored row stands in.
} as Row;

// SAFETY: the opener passes the record on and reads nothing of it.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stored row stands in.
const vm = {
  generation: 3,
  host: "203.0.113.5",
  workspaceId: "workspace:alice",
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  services.claim.mockResolvedValue({ kind: "claimed", row });
  services.usesVm.mockResolvedValue(true);
  services.ensure.mockResolvedValue({ kind: "ready", vm });
  services.prepare.mockResolvedValue(vm);
  services.open.mockResolvedValue({
    expiresAt: 0,
    id: "h_worker",
    result: null,
    state: "open",
    viewed: false,
  });
});

describe("opening a sign-in link", () => {
  it("keeps only a hash of the device's secret, and links nobody can guess", () => {
    expect(deviceHash("secret")).toMatch(/^[\da-f]{64}$/u);
    expect(deviceHash("secret")).not.toContain("secret");
    expect(new Set([newLinkId(), newLinkId(), newDeviceSecret()]).size).toBe(3);
    expect(newLinkId().length).toBeGreaterThanOrEqual(32);
  });

  it("hands over a viewer scoped to this one handoff, with the worker told the site and the fence", async () => {
    const opened = await openLoginHandoff(
      { deviceSecret: "secret", id: "link-1" },
      now
    );
    expect(opened.kind).toBe("ready");
    if (opened.kind !== "ready") throw new Error("unreachable");
    expect(opened.viewer.url).toBe(
      "wss://203-0-113-5.sslip.io/v1/handoff/h_worker/ws"
    );
    const claims = JSON.parse(
      Buffer.from(
        opened.viewer.token.split(".")[1] ?? "",
        "base64url"
      ).toString()
    );
    expect(claims).toMatchObject({
      env: "workspace:alice",
      gen: 3,
      ses: "h:h_worker",
    });
    expect(services.claim.mock.calls[0]?.[0].deviceHash).toBe(
      deviceHash("secret")
    );
    const [, input] = services.open.mock.calls[0] ?? [];
    expect(input).toMatchObject({
      domains: ["ozon.ru", "yandex.ru"],
      id: "h_worker",
      url: "https://www.ozon.ru/",
    });
    // The same sticky exit as every errand: the exit is not rotated for a sign-in.
    expect(services.prepare.mock.calls[0]?.[2]).toMatchObject({
      rotate: false,
    });
    expect(services.keep).toHaveBeenCalledWith("workspace:alice", true, now);
  });

  it("asks again later while the browser starts", async () => {
    services.ensure.mockResolvedValue({
      kind: "starting",
      retryAfterMs: 15_000,
    });
    expect(
      await openLoginHandoff({ deviceSecret: "secret", id: "link-1" }, now)
    ).toEqual({
      kind: "starting",
      retryAfterMs: 15_000,
    });
    expect(services.open).not.toHaveBeenCalled();
  });

  it("tells a busy browser, an old worker and a failure apart", async () => {
    const worker = (status: number) =>
      new BrowserVmWorkerError(status, "/v1/handoff", "");
    services.open.mockRejectedValueOnce(worker(409));
    expect(
      (await openLoginHandoff({ deviceSecret: "secret", id: "link-1" }, now))
        .kind
    ).toBe("busy");
    services.open.mockRejectedValueOnce(worker(404));
    expect(
      (await openLoginHandoff({ deviceSecret: "secret", id: "link-1" }, now))
        .kind
    ).toBe("unsupported");
    services.open.mockRejectedValueOnce(worker(500));
    expect(
      (await openLoginHandoff({ deviceSecret: "secret", id: "link-1" }, now))
        .kind
    ).toBe("failed");
  });

  it("gives the reason a link does not open, and opens nothing on a browser without a VM", async () => {
    services.claim.mockResolvedValue({ kind: "taken" });
    expect(
      await openLoginHandoff({ deviceSecret: "other", id: "link-1" }, now)
    ).toEqual({
      kind: "gone",
      reason: "taken",
    });
    services.claim.mockResolvedValue({ kind: "claimed", row });
    services.usesVm.mockResolvedValue(false);
    expect(
      (await openLoginHandoff({ deviceSecret: "secret", id: "link-1" }, now))
        .kind
    ).toBe("unsupported");
    expect(services.ensure).not.toHaveBeenCalled();
  });

  it("lets only the device that took the link finish it", async () => {
    services.read.mockResolvedValue(row);
    expect(await ownsLoginHandoff("link-1", "secret")).toBe(true);
    expect(await ownsLoginHandoff("link-1", "another device")).toBe(false);
    services.read.mockResolvedValue({ ...row, deviceHash: null });
    expect(await ownsLoginHandoff("link-1", "secret")).toBe(false);
    services.read.mockResolvedValue(undefined);
    expect(await ownsLoginHandoff("link-1", "secret")).toBe(false);
  });
});
