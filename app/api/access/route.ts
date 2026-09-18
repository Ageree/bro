import { createHash } from "node:crypto";
import { z } from "zod";
import {
  countOnboardingRequests,
  countRecentOnboardingRequests,
  findOnboardingRequest,
  recordOnboardingRequest,
} from "@db/services/onboarding-requests";
import { createPhotonSharedUser } from "@db/services/photon-users";
import { env } from "@shared/environment";
import { normalizeAuthPhoneNumber } from "@shared/identity/phone-number";
import { photonConfigured } from "@shared/photon/credentials";

export const runtime = "nodejs";

const onboardingRequestSchema = z.object({ phoneNumber: z.string() });

/** Everything a visitor sees when onboarding refuses, in their language. */
const messages = {
  closed: "Пока закрыто: свободных номеров не осталось. Загляни позже.",
  invalidPhoneNumber:
    "Проверь номер: нужен международный формат, например +7 999 123-45-67.",
  photonUnavailable:
    "Не получилось выдать номер. Попробуй ещё раз через минуту.",
  tooManyRequests: "Слишком много заявок с этого адреса. Попробуй через час.",
};

/**
 * Turns a visitor's phone number into the iMessage line Bro answers on. This
 * endpoint is public — the landing has no login — so it buys a Photon line
 * only under both ceilings, and it creates no account: the first inbound
 * iMessage does that.
 */
export async function POST(request: Request) {
  const payload = onboardingRequestSchema.safeParse(
    await request.json().catch(() => undefined)
  );
  const phoneNumber = payload.success
    ? normalizeAuthPhoneNumber(payload.data.phoneNumber)
    : undefined;
  if (!phoneNumber) return refuse(400, messages.invalidPhoneNumber);

  // A repeat visitor gets the line they already have, without a second
  // Photon user and without spending either ceiling.
  const existing = await findOnboardingRequest(phoneNumber);
  if (existing) {
    return Response.json({ assignedPhoneNumber: existing.assignedPhoneNumber });
  }

  if (!photonConfigured()) return refuse(503, messages.closed);

  const ipHash = callerDigest(request.headers);
  const recent = await countRecentOnboardingRequests(ipHash);
  if (recent >= env.ACCESS_CREATES_PER_HOUR) {
    return refuse(429, messages.tooManyRequests);
  }

  const provisioned = await countOnboardingRequests();
  if (provisioned >= env.ACCESS_IDENTITY_CAP) {
    return refuse(503, messages.closed);
  }

  const assignedPhoneNumber = await createPhotonSharedUser(
    phoneNumber,
    request.signal
  ).catch(() => undefined);
  if (!assignedPhoneNumber) return refuse(502, messages.photonUnavailable);

  return Response.json({
    assignedPhoneNumber: await recordOnboardingRequest({
      assignedPhoneNumber,
      ipHash,
      phoneNumber,
    }),
  });
}

function refuse(status: number, message: string) {
  return Response.json({ message }, { status });
}

/**
 * The per-hour ceiling needs to recognise a repeat caller, not to identify
 * one, so only a digest of the forwarded address is ever stored.
 */
function callerDigest(headers: Headers) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded ?? headers.get("x-real-ip") ?? "unknown";
  return createHash("sha256").update(address).digest("hex");
}
