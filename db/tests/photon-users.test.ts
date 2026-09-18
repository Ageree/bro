import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { photonProjectCredentials } from "@shared/photon/credentials";
import { createPhotonSharedUser } from "@db/services/photon-users";

const mocks = vi.hoisted(() => ({
  photonProjectCredentials: vi.fn<typeof photonProjectCredentials>(),
}));

vi.mock("@shared/photon/credentials", () => ({
  photonProjectCredentials: mocks.photonProjectCredentials,
}));

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.photonProjectCredentials.mockReturnValue({
    projectId: "project-1",
    projectSecret: "secret-1",
  });
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
