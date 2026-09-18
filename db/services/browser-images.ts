import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { browserImageArtifacts, db } from "@db";

export async function readReadyBrowserImageArtifact(
  scope: AccessScope,
  artifactId: string,
  options: { readonly rootSessionId?: string } = {}
) {
  const conditions = [
    eq(browserImageArtifacts.id, artifactId),
    eq(browserImageArtifacts.workspaceId, scope.workspaceId),
    eq(browserImageArtifacts.createdByUserId, scope.userId),
    eq(browserImageArtifacts.status, "ready"),
  ];
  if (options.rootSessionId) {
    conditions.push(
      eq(browserImageArtifacts.rootSessionId, options.rootSessionId)
    );
  }
  const rows = await db
    .select()
    .from(browserImageArtifacts)
    .where(and(...conditions))
    .limit(1);
  const row = rows[0];
  return row ? { ...row, createdAt: row.createdAt.toISOString() } : undefined;
}
