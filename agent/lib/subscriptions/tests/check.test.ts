import { describe, expect, it } from "vitest";
import { judgePriceCheck } from "@agent/lib/subscriptions/check";

const now = new Date("2026-10-05T12:00:00.000Z");
const watch: Parameters<typeof judgePriceCheck>[0] = {
  checkEverySeconds: 6 * 60 * 60,
  condition: { amount: 8_000, kind: "below" },
  expiresAt: new Date("2026-11-01T10:00:00.000Z"),
  failures: 0,
  source: {
    currency: "RUB",
    extractor: "jsonld",
    name: "Чайник",
    sku: "K780",
    url: "https://shop.example/p/1",
  },
  state: {
    baseline: 8_990,
    last: 8_990,
    lastSeenAt: "2026-10-02T10:00:00.000Z",
  },
};
const reading = {
  amount: 8_490,
  currency: "RUB",
  extractor: "jsonld" as const,
  kind: "price" as const,
  name: "Чайник",
  sku: "K780",
};

describe("judging a price check", () => {
  it("stays quiet above the threshold and checks again a period later", () => {
    expect(judgePriceCheck(watch, reading, now)).toEqual({
      kind: "quiet",
      nextCheckAt: new Date("2026-10-05T18:00:00.000Z"),
      state: {
        baseline: 8_990,
        last: 8_490,
        lastSeenAt: now.toISOString(),
      },
    });
  });

  it("reports a price below the threshold with the link the person gave", () => {
    const check = judgePriceCheck(watch, { ...reading, amount: 7_490 }, now);
    expect(check.kind).toBe("hit");
    if (check.kind !== "hit") return;
    expect(check.outcome).toMatchObject({ kind: "result", urgency: "normal" });
    expect(check.outcome.kind === "result" && check.outcome.summary).toContain(
      "https://shop.example/p/1"
    );
    // ru-RU groups thousands with a no-break space.
    expect(check.outcome.kind === "result" && check.outcome.summary).toMatch(
      /7\s490 RUB/u
    );
  });

  it("counts another product or no reading as a failure, backing off", () => {
    const other = judgePriceCheck(
      watch,
      { ...reading, amount: 10, sku: "FILTER" },
      now
    );
    expect(other).toMatchObject({ error: "another-product", kind: "failed" });
    const blocked = judgePriceCheck(
      { ...watch, failures: 1 },
      { kind: "blocked", reason: "http 403" },
      now
    );
    expect(blocked).toMatchObject({
      error: "blocked: http 403",
      kind: "failed",
      // Two failures: four periods later.
      nextCheckAt: new Date("2026-10-06T12:00:00.000Z"),
    });
    expect(judgePriceCheck(watch, { kind: "no-price" }, now)).toMatchObject({
      error: "no-price",
      kind: "failed",
    });
  });

  it("ends a watch whose term ran out, whatever the page says", () => {
    const check = judgePriceCheck(
      { ...watch, expiresAt: new Date("2026-10-05T11:00:00.000Z") },
      { ...reading, amount: 1 },
      now
    );
    expect(check).toMatchObject({
      kind: "expired",
      outcome: { kind: "result" },
    });
  });
});
