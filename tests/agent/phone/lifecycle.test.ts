import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as PhoneService from "@db/services/phone";
import { exolveFetch, freeNumber, ownedList, preflight } from "./provider";

type NumberRow = Awaited<ReturnType<typeof PhoneService.savePhoneQuote>>;
type RequestRow = Awaited<
  ReturnType<typeof PhoneService.claimPhoneNumberRequests>
>[number];

const phone = vi.hoisted(() => ({
  claimPhoneActivation: vi.fn<typeof PhoneService.claimPhoneActivation>(),
  changePhoneState: vi.fn<typeof PhoneService.changePhoneState>(),
  updatePhoneProvisioning: vi.fn<typeof PhoneService.updatePhoneProvisioning>(),
  claimPhoneNumberRequests:
    vi.fn<typeof PhoneService.claimPhoneNumberRequests>(),
  finishPhoneNumberRequest:
    vi.fn<typeof PhoneService.finishPhoneNumberRequest>(),
  phonePilot: vi.fn<typeof PhoneService.phonePilot>(() => true),
  readHeldPhoneNumbers: vi.fn<typeof PhoneService.readHeldPhoneNumbers>(),
  readPhoneNumber: vi.fn<typeof PhoneService.readPhoneNumber>(),
  savePhoneQuote: vi.fn<typeof PhoneService.savePhoneQuote>(),
}));

vi.mock("@shared/environment", () => ({
  env: {
    MTS_EXOLVE_API_KEY: "exolve-test-key",
    PHONE_AGENT_ID: "phone-test-agent",
    PHONE_MAX_SETUP_RUB: 1000,
    PHONE_MAX_MONTHLY_RUB: 1000,
    PHONE_MAX_SIP_MONTHLY_RUB: 1000,
  },
}));
vi.mock("@shared/phone/elevenlabs", () => ({
  requirePhoneAgentReady: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("@db/services/phone", () => phone);

const { activatePhone, provisionNewWorkspacePhones } =
  await import("@db/services/phone/lifecycle");

const scope = { userId: "owner", workspaceId: "workspace" };

function numberRow(stage: NumberRow["stage"], state: NumberRow["state"]) {
  return {
    id: "row",
    workspaceId: scope.workspaceId,
    ownerUserId: scope.userId,
    number: "+74950000001",
    state,
    stage,
    setupRub: 600,
    monthlyRub: 155,
    sipMonthlyRub: 0,
    quotedAt: new Date(),
    numberId: null,
    sipId: null,
    phoneNumberId: null,
    outboundPhoneNumberId: null,
    agentId: null,
    sessionId: null,
    conversationId: null,
    conversationChannel: null,
    leaseToken: "lease",
    leaseUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies NumberRow;
}

/** The row as the database would keep it: each patch lands on the same object. */
function claimRow(row: NumberRow) {
  phone.claimPhoneActivation.mockResolvedValue({ row, claimed: true });
  phone.updatePhoneProvisioning.mockImplementation((_id, _token, patch) =>
    Promise.resolve(Object.assign(row, patch))
  );
}

beforeEach(() => {
  phone.updatePhoneProvisioning.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("activating a quoted number", () => {
  it("returns a quote to the re-quotable state when the provider rejects the Lock", async () => {
    const row = numberRow("quoted", "provisioning");
    claimRow(row);
    const calls = exolveFetch({
      ...preflight(),
      "/number/customer/v1/GetList": ownedList([]),
      "/number/v1/Lock": () => ({ status: 409, body: {} }),
    });
    const result = await activatePhone(scope, row.id);
    expect(result).toMatchObject({ state: "quoted", stage: "quoted" });
    expect(calls).not.toContain("/number/v1/Buy");
  });

  it("sends a purchase that may have been charged to the operator instead of retrying it", async () => {
    const row = numberRow("buying", "provisioning");
    claimRow(row);
    const calls = exolveFetch({
      "/number/customer/v1/GetList": ownedList([]),
    });
    const result = await activatePhone(scope, row.id);
    expect(result.state).toBe("operator-required");
    expect(calls).not.toContain("/number/v1/Lock");
    expect(calls).not.toContain("/number/v1/Buy");
    expect(phone.updatePhoneProvisioning).toHaveBeenLastCalledWith(
      row.id,
      "lease",
      { state: "operator-required" },
      true
    );
  });
});

describe("a line stuck before its SIP exists", () => {
  const stuck = (minutes: number) => {
    const row = {
      ...numberRow("sip-creating", "provisioning"),
      numberId: "74950000001",
      createdAt: new Date(Date.now() - minutes * 60_000),
    };
    claimRow(row);
    return row;
  };

  it("tries the SIP again once the stage has sat for a while with no SIP at the carrier", async () => {
    const row = stuck(120);
    const calls = exolveFetch({
      ...preflight(),
      "/number/customer/v1/GetList": ownedList(["74950000001"]),
      "/number/customer/v1/GetSIPList": () => ({ body: { sips: [] } }),
    });
    await activatePhone(scope, row.id);
    expect(calls).toContain("/sip/v1/Create");
  });

  it("leaves a SIP creation that has just been sent alone", async () => {
    const row = stuck(2);
    const calls = exolveFetch({
      "/number/customer/v1/GetSIPList": () => ({ body: { sips: [] } }),
    });
    const result = await activatePhone(scope, row.id);
    expect(result.state).toBe("uncertain");
    expect(calls).not.toContain("/sip/v1/GetFees");
  });
});

describe("automatic allocation", () => {
  it("quotes a number no other workspace holds", async () => {
    const now = new Date();
    const request: RequestRow = {
      workspaceId: scope.workspaceId,
      ownerUserId: scope.userId,
      state: "working",
      attempts: 1,
      nextAttemptAt: now,
      leaseToken: "request-lease",
      leaseUntil: now,
      lastFailure: null,
      sessionId: null,
      conversationId: null,
      conversationChannel: null,
      createdAt: now,
      updatedAt: now,
    };
    const quoted = numberRow("quoted", "quoted");
    phone.claimPhoneNumberRequests.mockResolvedValue([request]);
    phone.readPhoneNumber.mockResolvedValue(null);
    phone.readHeldPhoneNumbers.mockResolvedValue(new Set(["+74950000001"]));
    phone.savePhoneQuote.mockResolvedValue(quoted);
    phone.claimPhoneActivation.mockResolvedValue({
      row: quoted,
      claimed: false,
    });
    exolveFetch({
      "/number/v1/GetFree": () => ({
        body: {
          numbers: [
            freeNumber("74950000001", 100),
            freeNumber("74950000002", 155),
          ],
        },
      }),
      "/sip/v1/GetFees": () => ({
        body: { install_fee: 0, subscription_fee: 0 },
      }),
    });
    await provisionNewWorkspacePhones();
    expect(phone.readHeldPhoneNumbers).toHaveBeenCalledWith(scope);
    expect(phone.savePhoneQuote).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({ number: "+74950000002" }),
      expect.anything()
    );
  });
});
