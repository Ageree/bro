import { eq, sql } from "drizzle-orm";
import { db, onboardingRequests } from "@db";

/** The line a phone number was already given, when it asked before. */
export async function findOnboardingRequest(phoneNumber: string) {
  const [request] = await db
    .select()
    .from(onboardingRequests)
    .where(eq(onboardingRequests.phoneNumber, phoneNumber))
    .limit(1);
  return request;
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
