import { eq } from "drizzle-orm";
import { db, user } from "@db";
import type { AccessScope } from "@shared/identity/access-scope";

const betterAuthPrincipalPrefix = "better-auth:";

/**
 * The phone number the account itself signs in with. It is the last fallback
 * for an errand that needs a number to enter: a person who signs in to Bro by
 * SMS has one even when the profile and the vault are empty. A principal that
 * is not a Better Auth account has none, which is not an error here.
 */
export async function readAccountPhoneNumber(scope: AccessScope) {
  if (!scope.userId.startsWith(betterAuthPrincipalPrefix)) return undefined;
  const rows = await db
    .select({ phoneNumber: user.phoneNumber })
    .from(user)
    .where(eq(user.id, scope.userId.slice(betterAuthPrincipalPrefix.length)))
    .limit(1);
  return rows[0]?.phoneNumber ?? undefined;
}
