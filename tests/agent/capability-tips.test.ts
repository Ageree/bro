import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Tips from "@db/services/capability-tips";
import { accessScopeForUser } from "@shared/identity/access-scope";

const mocks = vi.hoisted(() => ({
  claim: vi.fn<typeof Tips.claimCapabilityTip>(),
  phoneNumber: vi.fn<() => Promise<{ state: string } | null>>(),
  use: vi.fn<typeof Tips.readCapabilityHistory>(),
}));

vi.mock("@db/services/capability-tips", () => ({
  claimCapabilityTip: mocks.claim,
  readCapabilityHistory: mocks.use,
}));
vi.mock("@db/services/phone", () => ({
  phonePilot: () => true,
  readPhoneNumber: mocks.phoneNumber,
}));

const scope = accessScopeForUser("better-auth:user-1");

async function tipContext(
  words: string,
  channel: "telegram" | "web" = "telegram"
) {
  vi.resetModules();
  const { capabilityTipContext } = await import("@agent/lib/capability-tips");
  return capabilityTipContext(scope, { channel, words });
}

/** How many capabilities a context line names, one per bullet. */
const bullets = (line = "") => line.match(/^• /gmu)?.length ?? 0;

/** The capabilities the tip asked to claim, in the order it offered them. */
const candidates = () => mocks.claim.mock.calls[0]?.[1];

describe("capability tips", () => {
  beforeEach(() => {
    vi.stubEnv("CAPABILITY_TIPS_WORKSPACES", scope.workspaceId);
    vi.stubEnv("EVE_SCHEDULES", "on");
    vi.stubEnv("LOCATION_WORKSPACES", "*");
    mocks.phoneNumber.mockResolvedValue({ state: "active" });
    mocks.use.mockResolvedValue({
      googleConnected: false,
      lastTipAt: null,
      personTurns: 12,
      tools: ["send_message", "web_search", "phone-call"],
    });
    mocks.claim.mockImplementation(async (_workspace, offered, policy) =>
      offered.slice(0, policy.limit)
    );
  });

  // Not `vi.unstubAllEnvs()`: it would take back tests/setup-env.ts's own.
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("offers what the person has not tried, in order, and nothing they have", async () => {
    const lines = await tipContext("найди бар в центре на шестерых");
    expect(lines).toHaveLength(1);
    expect(candidates()).toEqual(["reminders", "google", "location"]);
    expect(bullets(lines[0])).toBe(3);
  });

  it("counts Google connected by the mail check as tried, and the place only in Telegram", async () => {
    mocks.use.mockResolvedValue({
      googleConnected: true,
      lastTipAt: null,
      personTurns: 12,
      tools: ["schedules-create"],
    });
    await tipContext("найди бар в центре на шестерых", "web");
    expect(candidates()).toEqual(["call"]);
  });

  it("leaves out calls until Bro's own number is ready", async () => {
    mocks.use.mockResolvedValue({
      googleConnected: false,
      lastTipAt: null,
      personTurns: 12,
      tools: [],
    });
    mocks.phoneNumber.mockResolvedValue({ state: "provisioning" });
    await tipContext("найди бар в центре на шестерых");
    expect(candidates()?.[0]).toBe("reminders");
  });

  it("stops at a recent tip without looking further", async () => {
    mocks.use.mockResolvedValue({
      googleConnected: false,
      lastTipAt: new Date(Date.now() - 60 * 60_000),
      personTurns: 12,
      tools: [],
    });
    expect(await tipContext("найди бар в центре на шестерых")).toEqual([]);
    expect(mocks.phoneNumber).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("says nothing when the claim gives no tip: spaced out or all rested", async () => {
    mocks.claim.mockResolvedValue([]);
    expect(await tipContext("найди бар в центре на шестерых")).toEqual([]);
  });

  it("waits for the introduction, a real request and the pilot", async () => {
    mocks.use.mockResolvedValue({
      googleConnected: false,
      lastTipAt: null,
      personTurns: 3,
      tools: [],
    });
    expect(await tipContext("найди бар в центре на шестерых")).toEqual([]);
    expect(await tipContext("ок спасибо")).toEqual([]);
    vi.stubEnv("CAPABILITY_TIPS_WORKSPACES", "personal:someone-else");
    expect(await tipContext("найди бар в центре на шестерых")).toEqual([]);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("answers «что ещё умеешь» from the history without spending a tip", async () => {
    const lines = await tipContext("а что ты еще можешь");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("звонки");
    // Reminders and the place, not Google: what needs connecting comes only
    // when the person asks for it (about-bro).
    expect(bullets(lines[0])).toBe(2);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("takes «что можешь посоветовать» for a request, not a question about Bro", async () => {
    await tipContext("что можешь посоветовать на ужин");
    await tipContext("что ты можешь сделать с этим файлом");
    expect(mocks.claim).toHaveBeenCalledTimes(2);
  });

  it("leaves the message as it was when the history cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.use.mockRejectedValue(new Error("connection refused"));
    expect(await tipContext("найди бар в центре на шестерых")).toEqual([]);
  });
});
