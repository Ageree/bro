import { createHash } from "node:crypto";
import * as z from "zod";
import {
  findOnboardingRequest,
  storeOnboardingLine,
} from "@db/services/onboarding-requests";
import {
  photonConfigured,
  photonProjectCredentials,
} from "@shared/photon/credentials";

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

/**
 * A line asked for at sign-in, not by a landing visitor: the row's caller
 * digest names the path, the visitor's address is not needed.
 */
const signInCallerHash = createHash("sha256").update("sign-in").digest("hex");

/**
 * The Bro line a signed-in phone writes to. Photon delivers an inbound
 * iMessage only from a phone registered as a project user («This number
 * didn't recognize yours»), so a person who signed in on the web is
 * registered here and gets the number Photon bound them to — not the
 * deployment's `IMESSAGE_PHONE_NUMBER`, which can name a line they are not
 * on. Photon is asked every time (it answers the same user for a phone):
 * rows the Convex import stored named lines of an earlier project (20.10,
 * the cabinet still linked +1 415). The stored line is kept for a Photon
 * that does not answer; undefined then means the deployment's number.
 */
export async function photonLineFor(phoneNumber: string) {
  if (!photonConfigured()) return undefined;
  try {
    const assignedPhoneNumber = await createPhotonSharedUser(
      phoneNumber,
      AbortSignal.timeout(5000)
    );
    await storeOnboardingLine({
      assignedPhoneNumber,
      ipHash: signInCallerHash,
      phoneNumber,
    });
    return assignedPhoneNumber;
  } catch (error) {
    // Nothing about the number goes to the log.
    console.warn("[photon] the line for a signed-in phone was not resolved", {
      error: error instanceof Error ? error.name : "unknown",
      message: error instanceof PhotonUserError ? error.message : undefined,
    });
    return (await findOnboardingRequest(phoneNumber).catch(() => undefined))
      ?.assignedPhoneNumber;
  }
}
