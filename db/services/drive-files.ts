import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { db, driveFileArtifacts } from "@db";

type DriveFileArtifactInput = Omit<
  typeof driveFileArtifacts.$inferInsert,
  "createdAt" | "createdByUserId" | "workspaceId"
>;

interface DriveFileVersion {
  readonly driveFileId: string;
  readonly driveVersion: string;
  readonly rootSessionId: string;
}

/** The copy of one file version this session already stored, if any. */
export async function findDriveFileArtifact(
  scope: AccessScope,
  file: DriveFileVersion
) {
  const rows = await db
    .select()
    .from(driveFileArtifacts)
    .where(
      and(
        eq(driveFileArtifacts.workspaceId, scope.workspaceId),
        eq(driveFileArtifacts.createdByUserId, scope.userId),
        eq(driveFileArtifacts.rootSessionId, file.rootSessionId),
        eq(driveFileArtifacts.driveFileId, file.driveFileId),
        eq(driveFileArtifacts.driveVersion, file.driveVersion)
      )
    )
    .limit(1);
  return rows[0];
}

/**
 * Records a stored file. A replayed tool step that stored the same version
 * first gets that row back instead of a second one.
 */
export async function saveDriveFileArtifact(
  scope: AccessScope,
  artifact: DriveFileArtifactInput
) {
  const inserted = await db
    .insert(driveFileArtifacts)
    .values({
      ...artifact,
      createdByUserId: scope.userId,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0] ?? (await findDriveFileArtifact(scope, artifact));
  if (!row) throw new Error("The Drive file could not be recorded.");
  return row;
}

export async function readDriveFileArtifact(
  scope: AccessScope,
  artifactId: string,
  options: { readonly rootSessionId?: string } = {}
) {
  const conditions = [
    eq(driveFileArtifacts.id, artifactId),
    eq(driveFileArtifacts.workspaceId, scope.workspaceId),
    eq(driveFileArtifacts.createdByUserId, scope.userId),
  ];
  if (options.rootSessionId) {
    conditions.push(
      eq(driveFileArtifacts.rootSessionId, options.rootSessionId)
    );
  }
  const rows = await db
    .select()
    .from(driveFileArtifacts)
    .where(and(...conditions))
    .limit(1);
  return rows[0];
}
