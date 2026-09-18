import { eq } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { db, workspaceMemberships, workspaces } from "@db";

export async function ensureScope(scope: AccessScope) {
  const createdAt = new Date();
  await db.transaction(async (transaction) => {
    await transaction
      .insert(workspaces)
      .values({ createdAt, id: scope.workspaceId })
      .onConflictDoNothing({ target: workspaces.id });
    await transaction
      .insert(workspaceMemberships)
      .values({
        createdAt,
        role: "owner",
        userId: scope.userId,
        workspaceId: scope.workspaceId,
      })
      .onConflictDoNothing({
        target: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
      });
  });
}

/**
 * The account a workspace belongs to. A provider callback names the workspace
 * and nothing else, so the scope every service takes is rebuilt from the
 * membership rather than from anything the caller sent.
 */
export async function readWorkspaceScope(
  workspaceId: string
): Promise<AccessScope | null> {
  const rows = await db
    .select({ userId: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .where(eq(workspaceMemberships.workspaceId, workspaceId))
    .limit(1);
  const userId = rows[0]?.userId;
  return userId ? { userId, workspaceId } : null;
}
