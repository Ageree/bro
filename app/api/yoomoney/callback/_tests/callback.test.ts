import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Connection from "@db/services/yoomoney/connection";
import type * as Onboarding from "@db/services/yoomoney/onboarding";
import type * as RequestScope from "@web/auth/request-scope";
import { UnauthenticatedError } from "@web/auth/request-scope";

const mocks = vi.hoisted(() => ({
  connected: vi.fn<typeof Onboarding.markYoomoneyOnboardingConnected>(),
  finish: vi.fn<typeof Connection.finishYoomoneyAuthorization>(),
  link: vi.fn<typeof Onboarding.yoomoneyOnboardingLink>(),
  ofState: vi.fn<typeof Onboarding.yoomoneyOnboardingOfState>(),
  scope: vi.fn<typeof RequestScope.requireRequestScope>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "device-secret" }) }),
}));
vi.mock("@db/services/yoomoney/connection", () => ({
  cancelYoomoneyAuthorization:
    vi.fn<typeof Connection.cancelYoomoneyAuthorization>(),
  finishYoomoneyAuthorization: mocks.finish,
}));
vi.mock("@db/services/yoomoney/onboarding", () => ({
  markYoomoneyOnboardingConnected: mocks.connected,
  yoomoneyOnboardingCookie: "bro_yoomoney",
  yoomoneyOnboardingLink: mocks.link,
  yoomoneyOnboardingOfState: mocks.ofState,
}));
vi.mock("@web/auth/request-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof RequestScope>()),
  requireRequestScope: mocks.scope,
}));

import { GET } from "@app/api/yoomoney/callback/route";

const alice = { userId: "alice", workspaceId: "workspace:alice" };
const id = "0f9f7a5e-5c1d-4f0b-9a52-2b6f0d3c1e11";
const state = "s".repeat(43);

const back = () =>
  GET(
    new Request(
      `https://example.com/api/yoomoney/callback?state=${state}&code=code-1`
    )
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockRejectedValue(new UnauthenticatedError());
  mocks.link.mockResolvedValue(`https://example.com/yoomoney/${id}?t=tok`);
  mocks.finish.mockResolvedValue({
    account: "4100111222333",
    cards: ["••9999"],
    onboardingId: id,
  });
});

describe("YooMoney's callback for a consent started on an onboarding page", () => {
  it("connects the wallet only for the device that proved itself there", async () => {
    // Another browser — the consent link sent to someone else — has no
    // device of the page and no session: nothing is connected.
    mocks.ofState.mockResolvedValue({ id, scope: undefined });
    const stranger = await back();
    expect(stranger.headers.get("location")).toBe(
      `https://example.com/yoomoney/${id}?t=tok&e=who`
    );
    expect(mocks.finish).not.toHaveBeenCalled();

    mocks.ofState.mockResolvedValue({ id, scope: alice });
    const person = await back();
    expect(mocks.finish).toHaveBeenCalledWith(alice, "code-1", state);
    expect(mocks.connected).toHaveBeenCalledWith(id, { cards: ["••9999"] });
    expect(person.headers.get("location")).toBe(
      `https://example.com/yoomoney/${id}?t=tok`
    );
  });
});
