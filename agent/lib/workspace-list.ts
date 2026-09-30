import { readWorkspaceScope } from "@db/services/scope";
import { readAccountEmail } from "@db/services/users";

/**
 * Whether a pilot list (BROWSER_VM_WORKSPACES and its kin) names the
 * workspace by its id or its owner's email. The email is looked up only when
 * the list has one. `userId` spares the membership lookup when the caller has
 * the scope: the workspace is personal, so its user is its owner.
 */
export async function listsWorkspace(
  entries: readonly string[] | undefined,
  scope: { readonly userId?: string; readonly workspaceId: string }
) {
  const list = entries ?? [];
  if (list.includes(scope.workspaceId)) return true;
  const emails = list
    .filter((entry) => entry.includes("@"))
    .map((entry) => entry.toLowerCase());
  if (emails.length === 0) return false;
  const userId =
    scope.userId ?? (await readWorkspaceScope(scope.workspaceId))?.userId;
  if (userId === undefined) return false;
  const email = await readAccountEmail({
    userId,
    workspaceId: scope.workspaceId,
  });
  return email !== undefined && emails.includes(email.toLowerCase());
}
