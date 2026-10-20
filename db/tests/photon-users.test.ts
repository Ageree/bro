import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  photonConfigured,
  photonProjectCredentials,
} from "@shared/photon/credentials";
import type {
  findOnboardingRequest,
  storeOnboardingLine,
} from "@db/services/onboarding-requests";
import {
  createPhotonSharedUser,
  photonLineFor,
} from "@db/services/photon-users";

const mocks = vi.hoisted(() => ({
  findOnboardingRequest: vi.fn<typeof findOnboardingRequest>(),
  photonConfigured: vi.fn<typeof photonConfigured>(),
  photonProjectCredentials: vi.fn<typeof photonProjectCredentials>(),
  storeOnboardingLine: vi.fn<typeof storeOnboardingLine>(),
}));

vi.mock("@shared/photon/credentials", () => ({
  photonConfigured: mocks.photonConfigured,
  photonProjectCredentials: mocks.photonProjectCredentials,
}));

vi.mock("@db/services/onboarding-requests", () => ({
  findOnboardingRequest: mocks.findOnboardingRequest,
  storeOnboardingLine: mocks.storeOnboardingLine,
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.photonProjectCredentials.mockReturnValue({
    projectId: "project-1",
    projectSecret: "secret-1",
  });
  mocks.photonConfigured.mockReturnValue(true);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Photon shared users", () => {
  it("creates a shared user for the visitor phone and returns its line", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        data: { assignedPhoneNumber: "+16282649335", id: "user-1" },
        succeed: true,
      })
    );

    const signal = AbortSignal.timeout(20_000);

    await expect(createPhotonSharedUser("+79991234567", signal)).resolves.toBe(
      "+16282649335"
    );
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://spectrum.photon.codes/projects/project-1/users/",
      {
        body: JSON.stringify({ phoneNumber: "+79991234567", type: "shared" }),
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from("project-1:secret-1").toString("base64")}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal,
      }
    );
  });

  it("reports a refused project without leaking the response body", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { message: "project suspended", succeed: false },
        {
          status: 402,
        }
      )
    );

    await expect(createPhotonSharedUser("+79991234567")).rejects.toThrow(
      "Photon rejected the shared user request with 402 (project suspended)."
    );
  });

  it("treats a success response without a line as a failure", async () => {
    fetchMock.mockResolvedValue(Response.json({ succeed: true }));

    await expect(createPhotonSharedUser("+79991234567")).rejects.toThrow(
      "Photon rejected the shared user request with 200."
    );
  });
});

describe("the line of a signed-in phone", () => {
  it("registers the phone and keeps the line Photon answered", async () => {
    // Photon delivered nothing from a phone that signed in on the web: it
    // was never a project user, and the cabinet linked another line.
    mocks.storeOnboardingLine.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(
      Response.json({
        data: { assignedPhoneNumber: "+16465792868", id: "user-2" },
        succeed: true,
      })
    );

    await expect(photonLineFor("+79991234567")).resolves.toBe("+16465792868");
    expect(mocks.storeOnboardingLine).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        assignedPhoneNumber: "+16465792868",
        phoneNumber: "+79991234567",
      })
    );
    expect(mocks.findOnboardingRequest).not.toHaveBeenCalled();
  });

  it("answers Photon's line over one an earlier project stored", async () => {
    // 20.10: the Convex import's row named +1 415, a line of an earlier
    // project, and the cabinet kept linking it.
    mocks.findOnboardingRequest.mockResolvedValue({
      assignedPhoneNumber: "+14155796445",
      createdAt: new Date(),
      ipHash: "hash",
      phoneNumber: "+79991234567",
    });
    mocks.storeOnboardingLine.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(
      Response.json({
        data: { assignedPhoneNumber: "+16282649335", id: "user-1" },
        succeed: true,
      })
    );

    await expect(photonLineFor("+79991234567")).resolves.toBe("+16282649335");
  });

  it("keeps the stored line while Photon refuses, and nothing without one", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ message: "limit", succeed: false }, { status: 402 })
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.findOnboardingRequest.mockResolvedValue({
      assignedPhoneNumber: "+16282649335",
      createdAt: new Date(),
      ipHash: "hash",
      phoneNumber: "+79991234567",
    });

    await expect(photonLineFor("+79991234567")).resolves.toBe("+16282649335");
    expect(mocks.storeOnboardingLine).not.toHaveBeenCalled();

    mocks.findOnboardingRequest.mockResolvedValue(undefined);
    await expect(photonLineFor("+79991234567")).resolves.toBeUndefined();
  });
});
