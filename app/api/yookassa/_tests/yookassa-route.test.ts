import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as BillingService from "@db/services/billing";
import type { extendPaidUntil, recordPayment } from "@db/services/billing";
import type { readWorkspaceScope } from "@db/services/scope";
import type {
  readYooKassaPayment,
  yooKassaConfigured,
} from "@db/services/yookassa";
import { POST } from "@app/api/yookassa/route";

const mocks = vi.hoisted(() => ({
  extendPaidUntil: vi.fn<typeof extendPaidUntil>(),
  readWorkspaceScope: vi.fn<typeof readWorkspaceScope>(),
  readYooKassaPayment: vi.fn<typeof readYooKassaPayment>(),
  recordPayment: vi.fn<typeof recordPayment>(),
  yooKassaConfigured: vi.fn<typeof yooKassaConfigured>(),
}));

vi.mock("@db/services/billing", async (importOriginal) => ({
  ...(await importOriginal<typeof BillingService>()),
  extendPaidUntil: mocks.extendPaidUntil,
  recordPayment: mocks.recordPayment,
}));
vi.mock("@db/services/scope", () => ({
  readWorkspaceScope: mocks.readWorkspaceScope,
}));
vi.mock("@db/services/yookassa", () => ({
  paymentAmountRub: () => 2000,
  readYooKassaPayment: mocks.readYooKassaPayment,
  yooKassaConfigured: mocks.yooKassaConfigured,
}));

const scope = { userId: "alice", workspaceId: "workspace:alice" };
const paidUntil = new Date("2026-02-09T00:00:00.000Z");

function notification(body: string) {
  return new Request("https://bro.example/api/yookassa", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function succeeded() {
  return {
    amount: { currency: "RUB", value: "2000.00" },
    id: "2f0a-succeeded",
    metadata: { workspaceId: scope.workspaceId },
    status: "succeeded" as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.yooKassaConfigured.mockReturnValue(true);
  mocks.readWorkspaceScope.mockResolvedValue(scope);
  mocks.readYooKassaPayment.mockResolvedValue(succeeded());
  mocks.extendPaidUntil.mockResolvedValue({ applied: true, paidUntil });
});

describe("YooKassa webhook", () => {
  it("takes only the payment id from the body and re-fetches the payment", async () => {
    const response = await POST(
      notification(
        JSON.stringify({
          event: "payment.succeeded",
          object: {
            // Everything but the id is a claim anyone could have posted.
            amount: { currency: "RUB", value: "999999.00" },
            id: "2f0a-succeeded",
            metadata: { workspaceId: "workspace:attacker" },
            status: "succeeded",
          },
        })
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      applied: true,
      paidUntil: paidUntil.toISOString(),
    });
    expect(mocks.readYooKassaPayment).toHaveBeenCalledExactlyOnceWith(
      "2f0a-succeeded",
      expect.anything()
    );
    expect(mocks.readWorkspaceScope).toHaveBeenCalledExactlyOnceWith(
      scope.workspaceId
    );
    expect(mocks.extendPaidUntil).toHaveBeenCalledExactlyOnceWith(
      scope,
      "2f0a-succeeded",
      30
    );
  });

  it("acknowledges a payment YooKassa does not know", async () => {
    mocks.readYooKassaPayment.mockResolvedValue(null);

    const response = await POST(
      notification(JSON.stringify({ object: { id: "missing" } }))
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ applied: false });
    expect(mocks.extendPaidUntil).not.toHaveBeenCalled();
  });

  it("records a payment that has not succeeded without granting access", async () => {
    mocks.readYooKassaPayment.mockResolvedValue({
      ...succeeded(),
      status: "canceled",
    });

    const response = await POST(
      notification(JSON.stringify({ object: { id: "2f0a" } }))
    );

    expect(response.status).toBe(200);
    expect(mocks.extendPaidUntil).not.toHaveBeenCalled();
    expect(mocks.recordPayment).toHaveBeenCalledExactlyOnceWith(scope, {
      amountRub: 2000,
      id: "2f0a-succeeded",
      status: "canceled",
    });
  });

  it("acknowledges a payment whose workspace no longer exists", async () => {
    mocks.readWorkspaceScope.mockResolvedValue(null);

    const response = await POST(
      notification(JSON.stringify({ object: { id: "2f0a" } }))
    );

    expect(response.status).toBe(200);
    expect(mocks.extendPaidUntil).not.toHaveBeenCalled();
  });

  it("refuses a body that is not a payment notification", async () => {
    const garbage = await POST(
      notification(JSON.stringify({ hello: "world" }))
    );
    const empty = await POST(
      new Request("https://bro.example/api/yookassa", {
        body: "not json",
        method: "POST",
      })
    );

    expect(garbage.status).toBe(400);
    expect(empty.status).toBe(400);
    expect(mocks.readYooKassaPayment).not.toHaveBeenCalled();
  });
});
