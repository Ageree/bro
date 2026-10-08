import { afterEach, describe, expect, it, vi } from "vitest";
import { PhonePreflightError } from "@shared/phone/errors";
import { exolveFetch, freeNumber, ownedList, preflight } from "./provider";

vi.mock("@shared/environment", () => ({
  env: { MTS_EXOLVE_API_KEY: "exolve-test-key" },
}));

const { purchaseNumber, quoteNumber } = await import("@shared/phone/exolve");

const purchase = {
  candidate: "+74950000001",
  maxSetupRub: 1000,
  maxMonthlyRub: 1000,
  maxSipMonthlyRub: 1000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Exolve purchase", () => {
  it("treats a rejected Lock as no purchase: nothing is bought and the quote can be taken again", async () => {
    const calls = exolveFetch({
      ...preflight(),
      "/number/customer/v1/GetList": ownedList([]),
      "/number/v1/Lock": () => ({ status: 409, body: { message: "taken" } }),
    });
    await expect(purchaseNumber(purchase)).rejects.toMatchObject({
      name: "PhonePreflightError",
      code: "CANDIDATE_UNAVAILABLE",
    });
    expect(calls).not.toContain("/number/v1/Buy");
  });

  it("keeps a failed Buy ambiguous and never retries it", async () => {
    const calls = exolveFetch({
      ...preflight(),
      "/number/customer/v1/GetList": ownedList([]),
      "/number/v1/Lock": () => ({ body: { Id: "77" } }),
      "/number/v1/Buy": () => ({ status: 500, body: {} }),
    });
    const failure = purchaseNumber(purchase);
    await expect(failure).rejects.toThrow("unverified");
    await expect(failure).rejects.not.toBeInstanceOf(PhonePreflightError);
    expect(calls.filter((path) => path === "/number/v1/Buy")).toHaveLength(1);
  });

  it("keeps a failed Lock ambiguous when the provider shows the number as ours", async () => {
    let lists = 0;
    const calls = exolveFetch({
      ...preflight(),
      "/number/customer/v1/GetList": () => {
        lists += 1;
        return ownedList(lists === 1 ? [] : ["74950000001"])();
      },
      "/number/v1/Lock": () => ({ status: 500, body: {} }),
    });
    await expect(purchaseNumber(purchase)).rejects.not.toBeInstanceOf(
      PhonePreflightError
    );
    expect(calls).not.toContain("/number/v1/Buy");
  });

  it("returns the number after a verified purchase", async () => {
    let lists = 0;
    exolveFetch({
      ...preflight(),
      "/number/customer/v1/GetList": () => {
        lists += 1;
        return ownedList(lists === 1 ? [] : ["74950000001"])();
      },
      "/number/v1/Lock": () => ({ body: { id: 5 } }),
      "/number/v1/Buy": () => ({ body: {} }),
    });
    await expect(purchaseNumber(purchase)).resolves.toEqual({
      numberId: "74950000001",
      number: "+74950000001",
    });
  });
});

const free = () => ({
  body: {
    numbers: [freeNumber("74950000001", 100), freeNumber("74950000002", 155)],
  },
});
const fees = () => ({ body: { install_fee: 0, subscription_fee: 0 } });

describe("Exolve quote", () => {
  it("quotes the cheapest free number", async () => {
    exolveFetch({ "/number/v1/GetFree": free, "/sip/v1/GetFees": fees });
    expect((await quoteNumber()).candidate).toBe("+74950000001");
  });

  it("skips numbers another workspace already holds", async () => {
    exolveFetch({ "/number/v1/GetFree": free, "/sip/v1/GetFees": fees });
    expect((await quoteNumber(new Set(["+74950000001"]))).candidate).toBe(
      "+74950000002"
    );
  });

  it("reports no candidate when every free number is held", async () => {
    exolveFetch({ "/number/v1/GetFree": free, "/sip/v1/GetFees": fees });
    await expect(
      quoteNumber(new Set(["+74950000001", "+74950000002"]))
    ).rejects.toMatchObject({ code: "CANDIDATE_UNAVAILABLE" });
  });
});
