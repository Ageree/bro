import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { db, directPurchaseConsents } from "@db";

type Database = Pick<typeof db, "insert" | "select">;

/**
 * Takes the person's request (`agent/lib/payments/direct.ts`) for the
 * purchase `ref`: true when it paid nothing else yet. The same purchase
 * taken up again keeps it; another one is not paid on it. Pass the
 * transaction of a claim that dispatches the payment, so the two stand or
 * fall together.
 */
export async function claimDirectPurchase(
  scope: Pick<AccessScope, "workspaceId">,
  input: { readonly consentKey: string; readonly ref: string },
  database: Database = db
) {
  const [inserted] = await database
    .insert(directPurchaseConsents)
    .values({
      workspaceId: scope.workspaceId,
      consentKey: input.consentKey,
      ref: input.ref,
    })
    .onConflictDoNothing()
    .returning({ ref: directPurchaseConsents.ref });
  if (inserted) return true;
  const [held] = await database
    .select({ ref: directPurchaseConsents.ref })
    .from(directPurchaseConsents)
    .where(
      and(
        eq(directPurchaseConsents.workspaceId, scope.workspaceId),
        eq(directPurchaseConsents.consentKey, input.consentKey)
      )
    )
    .limit(1);
  return held?.ref === input.ref;
}
