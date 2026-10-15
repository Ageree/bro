import { afterEach, describe, expect, it, vi } from "vitest";
import { findYoomoneyPayment } from "./payments";

/** The wallet's outgoing history, one page. */
function history(operations: readonly object[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ operations }))
  );
}

const operation = (status: string, patternId: string, amount: number) => ({
  operation_id: `${status}-${patternId}-${String(amount)}`,
  status,
  datetime: "2026-10-15T12:00:00Z",
  title: "Оплата услуг",
  direction: "out",
  amount,
  pattern_id: patternId,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const lookup = () =>
  findYoomoneyPayment("token-1", {
    amountMinor: 10_000,
    patternId: "337",
    since: new Date("2026-10-15T11:59:00Z"),
  });

describe("a lost service payment in the wallet's history", () => {
  it("is paid only by a successful payment to the same service for the same sum", async () => {
    history([
      operation("refused", "337", 100),
      operation("success", "335", 100),
      operation("success", "337", 100),
    ]);
    expect(await lookup()).toEqual({
      kind: "paid",
      operationId: "success-337-100",
    });
  });

  it("is not refused by someone's refused try of the same payment", async () => {
    history([
      operation("refused", "337", 100),
      operation("success", "335", 100),
    ]);
    expect(await lookup()).toEqual({ kind: "absent" });
  });
});
