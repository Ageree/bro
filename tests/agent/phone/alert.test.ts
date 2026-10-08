import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as PhoneService from "@db/services/phone";
import type * as OwnerAlert from "@agent/lib/owner-alert";

const mocks = vi.hoisted(() => ({
  alertOwner: vi.fn<typeof OwnerAlert.alertOwner>(),
  listPhoneOperatorRequired:
    vi.fn<typeof PhoneService.listPhoneOperatorRequired>(),
}));

vi.mock("@agent/lib/owner-alert", () => ({ alertOwner: mocks.alertOwner }));
vi.mock("@db/services/phone", () => ({
  listPhoneOperatorRequired: mocks.listPhoneOperatorRequired,
}));

const { alertPhoneOperator } = await import("@agent/lib/phone/alert");

const row = (id: string) => ({
  id,
  number: `+7495000000${id}`,
  stage: "buying" as const,
  updatedAt: new Date(),
});

beforeEach(() => {
  mocks.alertOwner.mockReset();
});

describe("phone operator alert", () => {
  it("tells the owner about every number that waits for the operator, once a day", async () => {
    mocks.listPhoneOperatorRequired.mockResolvedValue([row("1"), row("2")]);
    await alertPhoneOperator();
    expect(mocks.alertOwner).toHaveBeenCalledTimes(2);
    expect(mocks.alertOwner).toHaveBeenCalledWith(
      "phone-operator-required:1",
      expect.stringContaining("+74950000001"),
      { repeatAfterMs: 24 * 60 * 60_000 }
    );
  });

  it("stays silent when no number needs the operator", async () => {
    mocks.listPhoneOperatorRequired.mockResolvedValue([]);
    await alertPhoneOperator();
    expect(mocks.alertOwner).not.toHaveBeenCalled();
  });

  it("does not let a failed send stop the rest", async () => {
    mocks.listPhoneOperatorRequired.mockResolvedValue([row("1"), row("2")]);
    mocks.alertOwner.mockRejectedValueOnce(new Error("telegram down"));
    await expect(alertPhoneOperator()).resolves.toBeUndefined();
    expect(mocks.alertOwner).toHaveBeenCalledTimes(2);
  });
});
