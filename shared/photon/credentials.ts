import { env } from "@shared/environment";

/**
 * Resolves the portable Photon project credentials shared by the iMessage
 * channel and out-of-turn sign-in delivery. Credentials are read on first use
 * so a deployment without them still boots.
 */
export function photonProjectCredentials() {
  const projectId = env.IMESSAGE_PROJECT_ID;
  const projectSecret = env.IMESSAGE_PROJECT_SECRET;
  if (!projectId || !projectSecret) {
    throw new Error(
      "Photon is not configured for this deployment. Set IMESSAGE_PROJECT_ID and IMESSAGE_PROJECT_SECRET."
    );
  }
  return { projectId, projectSecret };
}

export function photonConfigured() {
  return (
    env.IMESSAGE_PROJECT_ID !== undefined &&
    env.IMESSAGE_PROJECT_SECRET !== undefined
  );
}
