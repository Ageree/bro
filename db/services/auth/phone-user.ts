import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, user } from "@db";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { ensureScope } from "@db/services/scope";

/**
 * Placeholder identity for a user who only ever signs in with a phone number.
 * Better Auth's `signUpOnVerification` and iMessage onboarding must synthesize
 * the same values so both paths converge on one account per phone number.
 */
export function phoneUserEmail(phoneNumber: string) {
  return `phone-${createHash("sha256")
    .update(phoneNumber)
    .digest("hex")}@local-vault.invalid`;
}

export const phoneUserName = "Phone user";

/**
 * Returns the verified user for a phone number, creating one when the number
 * has never signed in. Two first messages can arrive at once, so creation
 * relies on the unique phone number and email constraints and re-reads the
 * winning row instead of failing. `created` is true for exactly one call per
 * phone number, which is what lets the conversation greet a new person once.
 */
export async function ensureVerifiedPhoneUser(phoneNumber: string) {
  const existing = await findVerifiedPhoneUser(phoneNumber);
  if (existing) return { created: false, userId: existing };

  const [created] = await db
    .insert(user)
    .values({
      email: phoneUserEmail(phoneNumber),
      emailVerified: false,
      id: randomUUID(),
      name: phoneUserName,
      phoneNumber,
      phoneNumberVerified: true,
    })
    .onConflictDoNothing()
    .returning({ id: user.id });
  if (!created) {
    // A concurrent first message won the insert, so that turn owns the welcome.
    const winner = await findVerifiedPhoneUser(phoneNumber);
    return winner === undefined
      ? undefined
      : { created: false, userId: winner };
  }

  await ensureScope(accessScopeForUser(`better-auth:${created.id}`));
  return { created: true, userId: created.id };
}

async function findVerifiedPhoneUser(phoneNumber: string) {
  const [existing] = await db
    .select({ id: user.id, verified: user.phoneNumberVerified })
    .from(user)
    .where(eq(user.phoneNumber, phoneNumber))
    .limit(1);
  return existing?.verified === true ? existing.id : undefined;
}
