import { z } from "zod";
import { photonProjectCredentials } from "@shared/photon/credentials";

/**
 * Photon's REST surface for provisioning a line. The chat adapter only sends
 * messages, so onboarding calls the project API directly: a "shared" user is
 * one visitor phone bound to a Photon iMessage number that Bro answers on.
 */
const photonApiOrigin = "https://spectrum.photon.codes";

const photonUserResponseSchema = z.object({
  succeed: z.boolean().optional(),
  message: z.string().optional(),
  data: z
    .object({
      id: z.string().min(1),
      assignedPhoneNumber: z.string().min(1),
    })
    .optional(),
});

class PhotonUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotonUserError";
  }
}

/**
 * Creates (or re-resolves) the shared Photon user for one visitor phone and
 * returns the iMessage number assigned to it. Photon itself is idempotent per
 * phone number, but callers still reuse a stored assignment instead of asking
 * twice.
 */
export async function createPhotonSharedUser(
  phoneNumber: string,
  signal?: AbortSignal
) {
  const { projectId, projectSecret } = photonProjectCredentials();
  const credentials = Buffer.from(`${projectId}:${projectSecret}`).toString(
    "base64"
  );
  const response = await fetch(
    `${photonApiOrigin}/projects/${projectId}/users/`,
    {
      body: JSON.stringify({ phoneNumber, type: "shared" }),
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: signal ?? AbortSignal.timeout(20_000),
    }
  );

  const body = photonUserResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  );
  const user = body.success ? body.data : undefined;
  if (!response.ok || user?.succeed !== true || !user.data) {
    throw new PhotonUserError(
      `Photon rejected the shared user request with ${String(response.status)}${
        user?.message === undefined ? "" : ` (${user.message})`
      }.`
    );
  }
  return user.data.assignedPhoneNumber;
}
