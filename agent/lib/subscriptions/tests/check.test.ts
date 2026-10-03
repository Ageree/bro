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
    landedOn: "shop.example/p/1",
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
  landedOn: "shop.example/p/1",
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
    // A link a shop now sends to a replacement product is not this one.
    expect(
      judgePriceCheck(
        watch,
        { ...reading, amount: 10, landedOn: "shop.example/p/2" },
        now
      )
    ).toMatchObject({ error: "another-product", kind: "failed" });
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

  it("waits quietly while the product is out of stock", () => {
    expect(judgePriceCheck(watch, { kind: "unavailable" }, now)).toEqual({
      kind: "quiet",
      nextCheckAt: new Date("2026-10-05T18:00:00.000Z"),
      state: watch.state,
    });
  });

  it("tells the person why the watch stopped in plain words, not codes", () => {
    const check = judgePriceCheck(
      { ...watch, failures: 2 },
      { ...reading, sku: "FILTER" },
      now
    );
    expect(check.kind).toBe("failed");
    if (check.kind !== "failed") return;
    expect(check.error).toBe("another-product");
    const summary =
      check.outcome.kind === "blocked" ? check.outcome.summary : "";
    expect(summary).not.toContain("another-product");
    expect(summary).toContain("same product");
  });

  it("keeps a report short enough for its run to take it", () => {
    const check = judgePriceCheck(
      {
        ...watch,
        source: {
          ...watch.source,
          url: `https://shop.example/${"x".repeat(5_000)}`,
        },
      },
      { ...reading, amount: 7_000 },
      now
    );
    const summary =
      check.kind === "hit" && check.outcome.kind === "result"
        ? check.outcome.summary
        : "";
    expect(summary.length).toBeGreaterThan(3_000);
    expect(summary.length).toBeLessThanOrEqual(4_000);
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
