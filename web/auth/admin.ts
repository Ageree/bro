import { cache } from "react";
import { readAccountEmail } from "@db/services/users";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * Whether an account is on the owner's list: Better Auth user ids or emails,
 * compared without regard to case. An empty list admits nobody.
 */
export function adminListAdmits(
  admins: readonly string[],
  account: { readonly email: string | undefined; readonly id: string }
) {
  const wanted = new Set(admins.map((entry) => entry.toLowerCase()));
  return (
    wanted.has(account.id.toLowerCase()) ||
    (account.email !== undefined && wanted.has(account.email.toLowerCase()))
  );
}

/**
 * Whether the account behind `scope` is on `ADMIN_USER_IDS`. The check runs
 * on the server, for the page and for tRPC alike. The id is compared first;
 * the account's email is read only when the id is not listed, and once per
 * request however many times the layout and the page ask.
 */
export const isAdminScope = cache(async (scope: AccessScope) => {
  const admins = env.ADMIN_USER_IDS ?? [];
  if (admins.length === 0) return false;
  const id = scope.userId.replace(/^better-auth:/u, "");
  if (adminListAdmits(admins, { email: undefined, id })) return true;
  return adminListAdmits(admins, {
    email: await readAccountEmail(scope),
    id,
  });
});
