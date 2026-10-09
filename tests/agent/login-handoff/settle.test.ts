import { beforeEach, describe, expect, it, vi } from "vitest";
import { handoffRow } from "@tests/helpers/login-handoff";
import type { recordHandoffSignIn } from "@agent/lib/browser-use/sign-ins";
import type {
  cancelBrowserVmWorkerHandoff,
  readBrowserVmWorkerHandoff,
} from "@agent/lib/browser-vm/worker";
import type { loginHandoffs } from "@db/schema/login-handoffs";
import type {
  clearBrowserVmStopNotBefore,
  readBrowserVm,
  updateBrowserVm,
} from "@db/services/browser-vms";
import type {
  endLoginHandoff,
  expireLoginHandoffs,
  listClaimedLoginHandoffs,
} from "@db/services/login-handoffs";

const services = vi.hoisted(() => ({
  cancel: vi.fn<typeof cancelBrowserVmWorkerHandoff>(),
  clear: vi.fn<typeof clearBrowserVmStopNotBefore>(),
  end: vi.fn<typeof endLoginHandoff>(),
  expire: vi.fn<typeof expireLoginHandoffs>(),
  list: vi.fn<typeof listClaimedLoginHandoffs>(),
  read: vi.fn<typeof readBrowserVmWorkerHandoff>(),
  readVm: vi.fn<typeof readBrowserVm>(),
  record: vi.fn<typeof recordHandoffSignIn>(),
  update: vi.fn<typeof updateBrowserVm>(),
}));

vi.mock("@agent/lib/browser-use/sign-ins", () => ({
  recordHandoffSignIn: services.record,
}));
vi.mock("@agent/lib/browser-vm/worker", () => ({
  cancelBrowserVmWorkerHandoff: services.cancel,
  readBrowserVmWorkerHandoff: services.read,
}));
vi.mock("@db/services/browser-vms", () => ({
  clearBrowserVmStopNotBefore: services.clear,
  readBrowserVm: services.readVm,
  updateBrowserVm: services.update,
}));
vi.mock("@db/services/login-handoffs", () => ({
  endLoginHandoff: services.end,
  expireLoginHandoffs: services.expire,
  listClaimedLoginHandoffs: services.list,
}));

import {
  settleLoginHandoff,
  settleLoginHandoffs,
} from "@agent/lib/login-handoff/settle";

type Row = typeof loginHandoffs.$inferSelect;

const now = new Date("2026-10-09T12:00:00Z");
const minutes = (count: number) => count * 60_000;

function row(overrides: Partial<Row> = {}): Row {
  return handoffRow(overrides, now);
}

// SAFETY: the settler reads only the host of the VM record.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stored row stands in.
const vm = { host: "203.0.113.5", workspaceId: "workspace:alice" } as never;

function handed(
  state: "closing" | "done" | "cancelled" | "expired" | "open" | "viewing",
  result: {
    passwordField: boolean | null;
    url?: string;
    allowed?: boolean;
  } | null = null
) {
  return {
    expiresAt: 0,
    id: "h_worker",
    result:
      result === null
        ? null
        : {
            allowed: result.allowed ?? true,
            host: "www.ozon.ru",
            passwordField: result.passwordField,
            url: result.url ?? "https://www.ozon.ru/",
          },
    state,
    viewed: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  services.readVm.mockResolvedValue(vm);
  services.end.mockResolvedValue(row());
  services.cancel.mockResolvedValue(undefined);
});

describe("a handoff read off its worker", () => {
  it("ends done, records the sign-in and saves the profile when the page shows no form", async () => {
    services.read.mockResolvedValue(handed("done", { passwordField: false }));
    expect(await settleLoginHandoff(row(), now)).toBe("done");
    expect(services.end).toHaveBeenCalledWith(
      "link-1",
      expect.objectContaining({ signedIn: true, state: "done" }),
      now
    );
    expect(services.end.mock.calls[0]?.[1].report).toContain("ozon.ru");
    expect(services.record).toHaveBeenCalledWith("workspace:alice", {
      domain: "ozon.ru",
      now,
      page: "https://www.ozon.ru/",
    });
    expect(services.clear).toHaveBeenCalledWith("workspace:alice", now);
    // The sandbox is marked idle, so the next reconcile parks it and its profile reaches storage.
    const patch = services.update.mock.calls[0]?.[1];
    expect(patch?.lastUsedAt?.getTime()).toBeLessThan(
      now.getTime() - minutes(19)
    );
  });

  it("records nothing as signed in while the page still asks for a password", async () => {
    services.read.mockResolvedValue(handed("done", { passwordField: true }));
    await settleLoginHandoff(row(), now);
    expect(services.end.mock.calls[0]?.[1]).toMatchObject({
      signedIn: false,
      state: "done",
    });
    expect(services.record).not.toHaveBeenCalled();
  });

  it("says nothing it cannot know when the worker could not read the page", async () => {
    services.read.mockResolvedValue(handed("done", null));
    await settleLoginHandoff(row(), now);
    expect(services.end.mock.calls[0]?.[1]).toMatchObject({
      signedIn: null,
      state: "done",
    });
    expect(services.record).not.toHaveBeenCalled();
  });

  it("owes no word to a person who cancelled", async () => {
    services.read.mockResolvedValue(handed("cancelled"));
    expect(await settleLoginHandoff(row(), now)).toBe("cancelled");
    expect(services.end).toHaveBeenCalledWith(
      "link-1",
      { report: null, state: "cancelled" },
      now
    );
  });

  it("waits while the person is in it and the window lasts", async () => {
    services.read.mockResolvedValue(handed("viewing"));
    expect(await settleLoginHandoff(row(), now)).toBe("skipped");
    expect(services.end).not.toHaveBeenCalled();
  });

  it("closes one the window ran out on", async () => {
    services.read.mockResolvedValue(handed("viewing"));
    const late = row({ viewUntil: new Date(now.getTime() - minutes(4)) });
    expect(await settleLoginHandoff(late, now)).toBe("expired");
    expect(services.cancel).toHaveBeenCalledWith(vm, "h_worker");
    expect(services.end.mock.calls[0]?.[1]).toMatchObject({ state: "expired" });
  });

  it("does not call a handoff lost that the worker was never given", async () => {
    // A run held the browser when the page asked, or it was still starting.
    services.read.mockResolvedValue(undefined);
    const unopened = row({ workerOpenedAt: null });
    expect(await settleLoginHandoff(unopened, now)).toBe("skipped");
    expect(services.end).not.toHaveBeenCalled();
    const abandoned = row({
      viewUntil: new Date(now.getTime() - minutes(4)),
      workerOpenedAt: null,
    });
    expect(await settleLoginHandoff(abandoned, now)).toBe("expired");
    // Nobody was in it: no word to the conversation.
    expect(services.end).toHaveBeenCalledWith(
      "link-1",
      { report: null, state: "expired" },
      now
    );
  });

  it("fails one the worker lost under it, and expires one past its window", async () => {
    services.read.mockResolvedValue(undefined);
    expect(await settleLoginHandoff(row(), now)).toBe("failed");
    const late = row({ viewUntil: new Date(now.getTime() - minutes(1)) });
    expect(await settleLoginHandoff(late, now)).toBe("expired");
  });

  it("waits for a worker that does not answer, then gives up on it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    services.read.mockRejectedValue(new Error("down"));
    expect(await settleLoginHandoff(row(), now)).toBe("skipped");
    const late = row({ viewUntil: new Date(now.getTime() - minutes(4)) });
    expect(await settleLoginHandoff(late, now)).toBe("failed");
    expect(services.end.mock.calls[0]?.[1]).toMatchObject({ state: "failed" });
  });

  it("leaves a handoff that is not claimed alone", async () => {
    expect(await settleLoginHandoff(row({ state: "done" }), now)).toBe(
      "skipped"
    );
    expect(services.read).not.toHaveBeenCalled();
  });
});

describe("the minute tick", () => {
  it("expires unopened links and settles each open handoff, one failing not holding up the next", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    services.list.mockResolvedValue([row({ id: "a" }), row({ id: "b" })]);
    services.readVm.mockRejectedValueOnce(new Error("db"));
    services.read.mockResolvedValue(handed("done", { passwordField: false }));
    await settleLoginHandoffs(now);
    expect(services.expire).toHaveBeenCalledWith(now);
    expect(services.end).toHaveBeenCalledTimes(1);
    expect(services.end.mock.calls[0]?.[0]).toBe("b");
  });
});
