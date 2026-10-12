import { readAccountEmail } from "@db/services/turn-log";
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
 * on the server, for the page and for tRPC alike.
 */
export async function isAdminScope(scope: AccessScope) {
  const admins = env.ADMIN_USER_IDS ?? [];
  if (admins.length === 0) return false;
  return adminListAdmits(admins, {
    email: await readAccountEmail(scope.userId),
    id: scope.userId.replace(/^better-auth:/u, ""),
  });
}
