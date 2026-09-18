import { beforeEach, describe, expect, it, vi } from "vitest";
import type { recordPayment } from "@db/services/billing";
import type {
  createYooKassaPayment,
  yooKassaConfigured,
} from "@db/services/yookassa";
import type * as RequestScope from "@web/auth/request-scope";
import type { requireRequestScope } from "@web/auth/request-scope";
import { UnauthenticatedError } from "@web/auth/request-scope";
import { GET } from "@app/api/pay/route";

const mocks = vi.hoisted(() => ({
  createYooKassaPayment: vi.fn<typeof createYooKassaPayment>(),
  recordPayment: vi.fn<typeof recordPayment>(),
  requireRequestScope: vi.fn<typeof requireRequestScope>(),
  yooKassaConfigured: vi.fn<typeof yooKassaConfigured>(),
}));

vi.mock("@db/services/billing", () => ({
  recordPayment: mocks.recordPayment,
}));
vi.mock("@db/services/yookassa", () => ({
  createYooKassaPayment: mocks.createYooKassaPayment,
  paymentAmountRub: () => 2000,
  yooKassaConfigured: mocks.yooKassaConfigured,
}));
vi.mock("@web/auth/request-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof RequestScope>()),
  requireRequestScope: mocks.requireRequestScope,
}));

const scope = { userId: "alice", workspaceId: "workspace:alice" };

function payRequest() {
  return new Request("https://bro.example/api/pay");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.yooKassaConfigured.mockReturnValue(true);
  mocks.requireRequestScope.mockResolvedValue(scope);
  mocks.createYooKassaPayment.mockResolvedValue({
    confirmationUrl: "https://yoomoney.test/confirm",
    payment: { id: "2f0a-pending", status: "pending" },
  });
});

describe("checkout redirect", () => {
  it("creates a payment for the caller's workspace and hands off to YooKassa", async () => {
    const response = await GET(payRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://yoomoney.test/confirm"
    );
    expect(mocks.createYooKassaPayment).toHaveBeenCalledExactlyOnceWith(
      scope.workspaceId,
      "https://example.com/workspace?paid=1",
      expect.anything()
    );
    // Only the webhook's own re-fetch may move a payment to `succeeded`.
    expect(mocks.recordPayment).toHaveBeenCalledExactlyOnceWith(scope, {
      amountRub: 2000,
      id: "2f0a-pending",
      status: "pending",
    });
  });

  it("refuses in free mode before touching the account", async () => {
    mocks.yooKassaConfigured.mockReturnValue(false);

    const response = await GET(payRequest());

    expect(response.status).toBe(503);
    expect(mocks.requireRequestScope).not.toHaveBeenCalled();
    expect(mocks.createYooKassaPayment).not.toHaveBeenCalled();
  });

  it("answers a signed-out caller with 401", async () => {
    mocks.requireRequestScope.mockRejectedValue(new UnauthenticatedError());

    const response = await GET(payRequest());

    expect(response.status).toBe(401);
    expect(mocks.createYooKassaPayment).not.toHaveBeenCalled();
  });
});
