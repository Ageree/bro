import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Onboarding from "@db/services/yoomoney/onboarding";
import type * as RequestScope from "@web/auth/request-scope";
import { UnauthenticatedError } from "@web/auth/request-scope";

const mocks = vi.hoisted(() => ({
  claim: vi.fn<typeof Onboarding.claimYoomoneyOnboardingDevice>(),
  consent: vi.fn<typeof Onboarding.startYoomoneyOnboardingConsent>(),
  read: vi.fn<typeof Onboarding.readYoomoneyOnboardingByLink>(),
  scope: vi.fn<typeof RequestScope.requireRequestScope>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@db/services/yoomoney/onboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof Onboarding>()),
  claimYoomoneyOnboardingDevice: mocks.claim,
  readYoomoneyOnboardingByLink: mocks.read,
  startYoomoneyOnboardingConsent: mocks.consent,
}));
vi.mock("@web/auth/request-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof RequestScope>()),
  requireRequestScope: mocks.scope,
}));

const id = "0f9f7a5e-5c1d-4f0b-9a52-2b6f0d3c1e11";
const token = "123456:test-bot-token";

function launchData(userId: number) {
  const fields = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId }),
  };
  const checked = Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checked).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

async function press(
  form: Readonly<Record<string, string>>,
  origin = "https://example.com"
) {
  vi.resetModules();
  const { POST } = await import("@app/api/yoomoney/onboarding/[id]/route");
  return POST(
    new Request(`https://example.com/api/yoomoney/onboarding/${id}`, {
      body: new URLSearchParams({ t: "link-token", ...form }),
      headers: { origin },
      method: "POST",
    }),
    { params: Promise.resolve({ id }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TELEGRAM_BOT_TOKEN", token);
  mocks.scope.mockRejectedValue(new UnauthenticatedError());
  mocks.read.mockResolvedValue({
    id,
    workspaceId: "workspace:alice",
    userId: "alice",
    conversationChannel: "telegram",
    conversationId: "4242::",
    deviceHash: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    connectedAt: null,
    readyAt: null,
    resumedAt: null,
  });
  mocks.consent.mockResolvedValue("https://yoomoney.ru/oauth/authorize?x=1");
});

describe("the onboarding page's buttons", () => {
  it("start YooMoney's consent only for a device that proved it is the person's", async () => {
    expect(
      (await press({ action: "start" }, "https://evil.example")).status
    ).toBe(403);

    // Neither the cabinet's session nor Telegram's signed data: the page
    // says how to open it, and nothing starts.
    const unproved = await press({ action: "start", initData: "forged" });
    expect(unproved.status).toBe(303);
    expect(unproved.headers.get("location")).toContain("e=who");
    expect(mocks.consent).not.toHaveBeenCalled();

    mocks.claim.mockResolvedValue("device-secret");
    const proved = await press({
      action: "start",
      initData: launchData(4242),
    });
    expect(mocks.claim).toHaveBeenCalledWith(expect.objectContaining({ id }), {
      kind: "telegram",
      telegramUserId: "4242",
    });
    expect(proved.headers.get("location")).toBe(
      "https://yoomoney.ru/oauth/authorize?x=1"
    );
    expect(proved.headers.get("set-cookie")).toMatch(
      /^bro_yoomoney=device-secret;.*HttpOnly/iu
    );
  });
});
