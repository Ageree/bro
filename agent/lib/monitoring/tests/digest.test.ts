import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { summarizeOwnerDay } from "@db/services/turn-log";
import type { alertOwner } from "@agent/lib/owner-alert";

const mocks = vi.hoisted(() => ({
  alertOwner: vi.fn<typeof alertOwner>(),
  summarizeOwnerDay: vi.fn<typeof summarizeOwnerDay>(),
}));

vi.mock("@db/services/turn-log", () => ({
  summarizeOwnerDay: mocks.summarizeOwnerDay,
}));
vi.mock("@agent/lib/owner-alert", () => ({ alertOwner: mocks.alertOwner }));

const day = {
  activePeople: 2,
  costs: [
    { costRub: 12.345, label: "Алиса (+79990001122)", workspaceId: "a" },
    { costRub: 0.5, label: "bob@example.com", workspaceId: "b" },
  ],
  failures: [{ errorCode: "MODEL_CALL_FAILED 402", turns: 3 }],
  signedUp: ["bob@example.com"],
  turnsByKind: { background: 4, person: 10 },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.alertOwner.mockResolvedValue(true);
  mocks.summarizeOwnerDay.mockResolvedValue(day);
});

afterEach(() => {
  vi.stubEnv("OWNER_DIGEST_HOUR", "9");
});

async function digest(hour = "9") {
  vi.resetModules();
  vi.stubEnv("OWNER_DIGEST_HOUR", hour);
  return import("@agent/lib/monitoring/digest");
}

describe("the owner's daily summary", () => {
  it("names the day's people, turns, failures, cost and sign-ups", async () => {
    const { ownerDigestText } = await digest();
    expect(ownerDigestText(day)).toBe(
      [
        "Сводка за сутки",
        "Активных людей: 2",
        "Ходов: 14 (фоновые и расписания — 4, сообщения людей — 10)",
        "Сбои: MODEL_CALL_FAILED 402 — 3",
        "Расход: 12.85 ₽",
        "  Алиса (+79990001122): 12.35 ₽",
        "  bob@example.com: 0.50 ₽",
        "Новые регистрации (1): bob@example.com",
      ].join("\n")
    );
  });

  it("is sent in its hour, Moscow time, over the last 24 hours", async () => {
    const { sendOwnerDigest } = await digest("9");
    const now = new Date("2026-10-12T06:07:00.000Z");

    await expect(sendOwnerDigest(now)).resolves.toBe(true);
    expect(mocks.summarizeOwnerDay).toHaveBeenCalledWith({
      from: new Date("2026-10-11T06:07:00.000Z"),
      to: now,
    });
    expect(mocks.alertOwner).toHaveBeenCalledWith(
      "owner-digest",
      expect.stringContaining("Сводка за сутки"),
      { now, repeatAfterMs: 20 * 60 * 60_000 }
    );
  });

  // Review of U3a: a send that failed in its hour waited a whole day.
  it("is tried again for a few hours after its hour, not later", async () => {
    const { sendOwnerDigest } = await digest("9");
    // 12:07 Moscow: the last hour a failed summary is tried again.
    await expect(
      sendOwnerDigest(new Date("2026-10-12T09:07:00.000Z"))
    ).resolves.toBe(true);
    // 13:07 and 08:07 Moscow: outside the window.
    await expect(
      sendOwnerDigest(new Date("2026-10-12T10:07:00.000Z"))
    ).resolves.toBe(false);
    await expect(
      sendOwnerDigest(new Date("2026-10-12T05:07:00.000Z"))
    ).resolves.toBe(false);
    expect(mocks.summarizeOwnerDay).toHaveBeenCalledTimes(1);
  });

  it("wraps the window past midnight", async () => {
    const { sendOwnerDigest } = await digest("23");
    // 01:07 Moscow, two hours after 23:00.
    await expect(
      sendOwnerDigest(new Date("2026-10-11T22:07:00.000Z"))
    ).resolves.toBe(true);
  });
});
