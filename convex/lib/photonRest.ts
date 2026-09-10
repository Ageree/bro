import { photonSmsLink, PHOTON_ONBOARD_BODY } from "./photonPolicy";

export type PhotonSharedUser = {
  id: string;
  phoneNumber?: string;
  assignedPhoneNumber?: string;
};

function projectId(): string {
  const id = process.env.SPECTRUM_PROJECT_ID?.trim();
  if (!id) throw new Error("SPECTRUM_PROJECT_ID missing");
  return id;
}

function projectSecret(): string {
  const secret = process.env.SPECTRUM_PROJECT_SECRET?.trim();
  if (!secret) throw new Error("SPECTRUM_PROJECT_SECRET missing");
  return secret;
}

export function photonRedirectUrl(userId: string, msg = PHOTON_ONBOARD_BODY): string {
  return `https://spectrum.photon.codes/users/${userId}/redirect?msg=${encodeURIComponent(msg)}`;
}

export function photonAuthHeader(): string {
  return `Basic ${Buffer.from(`${projectId()}:${projectSecret()}`).toString("base64")}`;
}

export async function upsertPhotonSharedUser(opts: {
  phoneNumber: string;
  firstName?: string;
}): Promise<PhotonSharedUser> {
  const res = await fetch(
    `https://spectrum.photon.codes/projects/${projectId()}/users/`,
    {
      method: "POST",
      headers: {
        Authorization: photonAuthHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "shared",
        phoneNumber: opts.phoneNumber,
        ...(opts.firstName ? { firstName: opts.firstName } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const text = await res.text();
  let json: { succeed?: boolean; data?: PhotonSharedUser; message?: string } = {};
  try {
    json = text ? (JSON.parse(text) as typeof json) : {};
  } catch {
    json = {};
  }
  if (!res.ok || !json.succeed || !json.data?.id) {
    throw new Error(`photon user ${res.status}: ${json.message ?? text.slice(0, 200)}`);
  }
  return json.data;
}

export function smsLinkForPhotonUser(user: PhotonSharedUser): string | undefined {
  const assigned = user.assignedPhoneNumber?.trim();
  if (!assigned) return undefined;
  return photonSmsLink(assigned);
}
