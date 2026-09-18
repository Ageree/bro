import { and, count, eq, gte, sql } from "drizzle-orm";
import { db, onboardingRequests } from "@db";

/** The window the per-caller onboarding ceiling is counted over. */
const onboardingWindowMs = 60 * 60_000;

/** The line a phone number was already given, when it asked before. */
export async function findOnboardingRequest(phoneNumber: string) {
  const [request] = await db
    .select()
    .from(onboardingRequests)
    .where(eq(onboardingRequests.phoneNumber, phoneNumber))
    .limit(1);
  return request;
}

/** Every line handed out so far, counted against the identity cap. */
export async function countOnboardingRequests() {
  const [row] = await db.select({ value: count() }).from(onboardingRequests);
  return row?.value ?? 0;
}

/** Lines handed out to one caller inside the rate-limit window. */
export async function countRecentOnboardingRequests(
  ipHash: string,
  now = new Date()
) {
  const [row] = await db
    .select({ value: count() })
    .from(onboardingRequests)
    .where(
      and(
        eq(onboardingRequests.ipHash, ipHash),
        gte(
          onboardingRequests.createdAt,
          new Date(now.getTime() - onboardingWindowMs)
        )
      )
    );
  return row?.value ?? 0;
}

/**
 * Stores the assignment and returns the number this phone is bound to. A
 * concurrent duplicate keeps the number the first request stored: a visitor
 * must never end up with two lines for one phone.
 */
export async function recordOnboardingRequest(request: {
  readonly assignedPhoneNumber: string;
  readonly ipHash: string;
  readonly phoneNumber: string;
}) {
  const [stored] = await db
    .insert(onboardingRequests)
    .values(request)
    .onConflictDoUpdate({
      set: {
        assignedPhoneNumber: sql`${onboardingRequests.assignedPhoneNumber}`,
      },
      target: onboardingRequests.phoneNumber,
    })
    .returning({
      assignedPhoneNumber: onboardingRequests.assignedPhoneNumber,
    });
  return stored?.assignedPhoneNumber ?? request.assignedPhoneNumber;
}
