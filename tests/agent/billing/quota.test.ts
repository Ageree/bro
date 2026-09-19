import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessScope } from "@shared/identity/access-scope";

interface TestEnvironment {
  USAGE_LIMITS: "off" | "on";
}

const mocks = vi.hoisted(() => {
  const env: TestEnvironment = { USAGE_LIMITS: "off" };
  return {
    countUsage: vi.fn<() => Promise<number>>(() => Promise.resolve(1)),
    env,
    readBillingState: vi.fn<() => Promise<{ paid: boolean }>>(() =>
      Promise.resolve({ paid: false })
    ),
    readWorkspaceTimeZone: vi.fn<() => Promise<string>>(() =>
      Promise.resolve("Europe/Moscow")
    ),
    yooKassaConfigured: vi.fn<() => boolean>(() => false),
  };
});

vi.mock("@shared/environment", () => ({ env: mocks.env }));
vi.mock("@shared/environment/origin", () => ({
  applicationOrigin: () => "https://example.com",
}));
vi.mock("@db/services/billing", () => ({
  readBillingState: mocks.readBillingState,
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: mocks.readWorkspaceTimeZone,
}));
vi.mock("@db/services/usage", () => ({ countUsage: mocks.countUsage }));
vi.mock("@db/services/yookassa", () => ({
  yooKassaConfigured: mocks.yooKassaConfigured,
}));

const scope: AccessScope = { userId: "alice", workspaceId: "workspace:alice" };

afterEach(() => {
  vi.clearAllMocks();
  mocks.env.USAGE_LIMITS = "off";
});

describe("quota gates with USAGE_LIMITS off", () => {
  it("allows every message without touching usage counters", async () => {
    const { messageQuotaGate } = await import("@agent/lib/billing/quota");

    const gate = await messageQuotaGate(scope);

    expect(gate).toEqual({ allowed: true, paywallText: undefined });
    expect(mocks.countUsage).not.toHaveBeenCalled();
    expect(mocks.readBillingState).not.toHaveBeenCalled();
  });

  it("allows every browser errand without touching usage counters", async () => {
    const { browserRunQuotaGate } = await import("@agent/lib/billing/quota");

    const gate = await browserRunQuotaGate(scope);

    expect(gate).toEqual({ allowed: true, note: undefined });
    expect(mocks.countUsage).not.toHaveBeenCalled();
    expect(mocks.readBillingState).not.toHaveBeenCalled();
  });
});

describe("quota gates with USAGE_LIMITS on", () => {
  it("turns a message away once the free ceiling is passed", async () => {
    mocks.env.USAGE_LIMITS = "on";
    mocks.countUsage.mockResolvedValueOnce(31).mockResolvedValueOnce(1);
    const { messageQuotaGate } = await import("@agent/lib/billing/quota");

    const gate = await messageQuotaGate(scope);

    expect(gate.allowed).toBe(false);
    expect(gate.paywallText).toContain("Лимит сообщений");
  });

  it("turns a browser errand away once the free ceiling is passed", async () => {
    mocks.env.USAGE_LIMITS = "on";
    mocks.countUsage.mockResolvedValueOnce(6);
    const { browserRunQuotaGate } = await import("@agent/lib/billing/quota");

    const gate = await browserRunQuotaGate(scope);

    expect(gate.allowed).toBe(false);
    expect(gate.note).toContain("Лимит браузерных поручений");
  });
});
