import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { db, gmailAttachmentArtifacts } from "@db";

type GmailAttachmentArtifactInput = Omit<
  typeof gmailAttachmentArtifacts.$inferInsert,
  "createdAt" | "createdByUserId" | "workspaceId"
>;

/** The copy of one message part this session already stored, if any. */
export async function findGmailAttachmentArtifact(
  scope: AccessScope,
  part: {
    readonly gmailMessageId: string;
    readonly gmailPartId: string;
    readonly rootSessionId: string;
  }
) {
  const rows = await db
    .select()
    .from(gmailAttachmentArtifacts)
    .where(
      and(
        eq(gmailAttachmentArtifacts.workspaceId, scope.workspaceId),
        eq(gmailAttachmentArtifacts.createdByUserId, scope.userId),
        eq(gmailAttachmentArtifacts.rootSessionId, part.rootSessionId),
        eq(gmailAttachmentArtifacts.gmailMessageId, part.gmailMessageId),
        eq(gmailAttachmentArtifacts.gmailPartId, part.gmailPartId)
      )
    )
    .limit(1);
  return rows[0];
}

/**
 * Records a stored attachment. A replayed tool step that stored the same part
 * first gets that row back instead of a second one.
 */
export async function saveGmailAttachmentArtifact(
  scope: AccessScope,
  artifact: GmailAttachmentArtifactInput
) {
  const inserted = await db
    .insert(gmailAttachmentArtifacts)
    .values({
      ...artifact,
      createdByUserId: scope.userId,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoNothing()
    .returning();
  const row =
    inserted[0] ??
    (await findGmailAttachmentArtifact(scope, {
      gmailMessageId: artifact.gmailMessageId,
      gmailPartId: artifact.gmailPartId,
      rootSessionId: artifact.rootSessionId,
    }));
  if (!row) throw new Error("The Gmail attachment could not be recorded.");
  return row;
}

export async function readGmailAttachmentArtifact(
  scope: AccessScope,
  artifactId: string,
  options: { readonly rootSessionId?: string } = {}
) {
  const conditions = [
    eq(gmailAttachmentArtifacts.id, artifactId),
    eq(gmailAttachmentArtifacts.workspaceId, scope.workspaceId),
    eq(gmailAttachmentArtifacts.createdByUserId, scope.userId),
  ];
  if (options.rootSessionId) {
    conditions.push(
      eq(gmailAttachmentArtifacts.rootSessionId, options.rootSessionId)
    );
  }
  const rows = await db
    .select()
    .from(gmailAttachmentArtifacts)
    .where(and(...conditions))
    .limit(1);
  return rows[0];
}
