import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  countOnboardingRequests,
  countRecentOnboardingRequests,
  findOnboardingRequest,
  recordOnboardingRequest,
} from "@db/services/onboarding-requests";
import type { createPhotonSharedUser } from "@db/services/photon-users";
import type { photonConfigured } from "@shared/photon/credentials";
import { POST } from "@app/api/access/route";

const mocks = vi.hoisted(() => ({
  countOnboardingRequests: vi.fn<typeof countOnboardingRequests>(),
  countRecentOnboardingRequests: vi.fn<typeof countRecentOnboardingRequests>(),
  createPhotonSharedUser: vi.fn<typeof createPhotonSharedUser>(),
  findOnboardingRequest: vi.fn<typeof findOnboardingRequest>(),
  photonConfigured: vi.fn<typeof photonConfigured>(),
  recordOnboardingRequest: vi.fn<typeof recordOnboardingRequest>(),
}));

vi.mock("@db/services/onboarding-requests", () => ({
  countOnboardingRequests: mocks.countOnboardingRequests,
  countRecentOnboardingRequests: mocks.countRecentOnboardingRequests,
  findOnboardingRequest: mocks.findOnboardingRequest,
  recordOnboardingRequest: mocks.recordOnboardingRequest,
}));
vi.mock("@db/services/photon-users", () => ({
  createPhotonSharedUser: mocks.createPhotonSharedUser,
}));
vi.mock("@shared/photon/credentials", () => ({
  photonConfigured: mocks.photonConfigured,
}));

const assignedPhoneNumber = "+16282649335";
// Only the first forwarded address identifies the caller.
const callerDigest = createHash("sha256").update("203.0.113.7").digest("hex");

function accessRequest(phoneNumber: string) {
  return new Request("https://bro.example/api/access", {
    body: JSON.stringify({ phoneNumber }),
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.7, 198.51.100.4",
    },
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.countOnboardingRequests.mockResolvedValue(0);
  mocks.countRecentOnboardingRequests.mockResolvedValue(0);
  mocks.createPhotonSharedUser.mockResolvedValue(assignedPhoneNumber);
  mocks.findOnboardingRequest.mockResolvedValue(undefined);
  mocks.photonConfigured.mockReturnValue(true);
  mocks.recordOnboardingRequest.mockResolvedValue(assignedPhoneNumber);
});

describe("landing onboarding endpoint", () => {
  it("buys one Photon line and replays it for the same phone", async () => {
    const created = await POST(accessRequest("+7 999 123-45-67"));

    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toEqual({ assignedPhoneNumber });
    expect(mocks.createPhotonSharedUser).toHaveBeenCalledExactlyOnceWith(
      "+79991234567",
      expect.anything()
    );
    expect(mocks.recordOnboardingRequest).toHaveBeenCalledExactlyOnceWith({
      assignedPhoneNumber,
      ipHash: callerDigest,
      phoneNumber: "+79991234567",
    });

    mocks.findOnboardingRequest.mockResolvedValue({
      assignedPhoneNumber,
      createdAt: new Date("2026-09-18T10:00:00.000Z"),
      ipHash: "digest",
      phoneNumber: "+79991234567",
    });
    const replayed = await POST(accessRequest("+79991234567"));

    expect(replayed.status).toBe(200);
    await expect(replayed.json()).resolves.toEqual({ assignedPhoneNumber });
    expect(mocks.createPhotonSharedUser).toHaveBeenCalledTimes(1);
  });

  it("refuses a number that is not a phone number", async () => {
    const response = await POST(accessRequest("нет"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      message:
        "Проверь номер: нужен международный формат, например +7 999 123-45-67.",
    });
    expect(mocks.createPhotonSharedUser).not.toHaveBeenCalled();
  });

  it("closes the hour once a caller reached its ceiling", async () => {
    mocks.countRecentOnboardingRequests.mockResolvedValue(20);

    const response = await POST(accessRequest("+79991234567"));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      message: "Слишком много заявок с этого адреса. Попробуй через час.",
    });
    expect(mocks.createPhotonSharedUser).not.toHaveBeenCalled();
  });

  it("closes onboarding once the identity cap is reached", async () => {
    mocks.countOnboardingRequests.mockResolvedValue(100);

    const response = await POST(accessRequest("+79991234567"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      message: "Пока закрыто: свободных номеров не осталось. Загляни позже.",
    });
    expect(mocks.createPhotonSharedUser).not.toHaveBeenCalled();
  });

  it("closes onboarding when this deployment has no Photon project", async () => {
    mocks.photonConfigured.mockReturnValue(false);

    const response = await POST(accessRequest("+79991234567"));

    expect(response.status).toBe(503);
    expect(mocks.createPhotonSharedUser).not.toHaveBeenCalled();
  });
});
