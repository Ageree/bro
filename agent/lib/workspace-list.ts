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

/**
 * How long a workspace's verdict by its owner's email holds for a check
 * that runs at every step: without it a pilot named by email paid a lookup
 * of the email at each one.
 */
const verdictLifetimeMs = 10 * 60_000;

const verdicts = new Map<
  string,
  { readonly expiresAt: number; readonly listed: boolean }
>();

/**
 * `listsWorkspace` for a pilot asked at every step (STEP_CONTEXT_WORKSPACES,
 * SANDBOX_WORKSPACES): a verdict by the owner's email is remembered per list
 * and workspace for ten minutes. A failed lookup throws and is not
 * remembered.
 */
export async function listsWorkspaceRemembered(
  entries: readonly string[] | undefined,
  scope: { readonly userId?: string; readonly workspaceId: string }
) {
  const list = entries ?? [];
  if (list.includes(scope.workspaceId)) return true;
  if (!list.some((entry) => entry.includes("@"))) return false;
  const key = `${list.join(",")}\n${scope.workspaceId}`;
  const now = Date.now();
  const known = verdicts.get(key);
  if (known && known.expiresAt > now) return known.listed;
  const listed = await listsWorkspace(list, scope);
  verdicts.set(key, { expiresAt: now + verdictLifetimeMs, listed });
  return listed;
}
