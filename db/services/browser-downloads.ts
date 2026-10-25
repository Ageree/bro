import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { browserDownloadArtifacts, db } from "@db";

type BrowserDownloadArtifactInput = Omit<
  typeof browserDownloadArtifacts.$inferInsert,
  "createdAt" | "createdByUserId" | "workspaceId"
>;

/** The copy of one file of a run already stored, if any. */
export async function findBrowserDownloadArtifact(
  scope: AccessScope,
  file: { readonly browserRunId: string; readonly path: string }
) {
  const rows = await db
    .select()
    .from(browserDownloadArtifacts)
    .where(
      and(
        eq(browserDownloadArtifacts.workspaceId, scope.workspaceId),
        eq(browserDownloadArtifacts.createdByUserId, scope.userId),
        eq(browserDownloadArtifacts.browserRunId, file.browserRunId),
        eq(browserDownloadArtifacts.path, file.path)
      )
    )
    .limit(1);
  return rows[0];
}

/**
 * Records a stored file. A settle that stored the same file of the run first
 * gets that row back instead of a second one.
 */
export async function saveBrowserDownloadArtifact(
  scope: AccessScope,
  artifact: BrowserDownloadArtifactInput
) {
  const inserted = await db
    .insert(browserDownloadArtifacts)
    .values({
      ...artifact,
      createdByUserId: scope.userId,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoNothing()
    .returning();
  const row =
    inserted[0] ??
    (await findBrowserDownloadArtifact(scope, {
      browserRunId: artifact.browserRunId,
      path: artifact.path,
    }));
  if (!row) throw new Error("The downloaded file could not be recorded.");
  return row;
}

export async function readBrowserDownloadArtifact(
  scope: AccessScope,
  artifactId: string,
  options: { readonly rootSessionId?: string } = {}
) {
  const conditions = [
    eq(browserDownloadArtifacts.id, artifactId),
    eq(browserDownloadArtifacts.workspaceId, scope.workspaceId),
    eq(browserDownloadArtifacts.createdByUserId, scope.userId),
  ];
  if (options.rootSessionId) {
    conditions.push(
      eq(browserDownloadArtifacts.rootSessionId, options.rootSessionId)
    );
  }
  const rows = await db
    .select()
    .from(browserDownloadArtifacts)
    .where(and(...conditions))
    .limit(1);
  return rows[0];
}
