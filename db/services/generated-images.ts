import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { db, generatedImageArtifacts } from "@db";
import { ensureScope } from "./scope";

type GeneratedImageArtifactInput = Omit<
  typeof generatedImageArtifacts.$inferInsert,
  "createdAt" | "createdByUserId" | "id" | "workspaceId"
>;

/**
 * Records a drawn picture that already sits in private Blob. A replayed tool
 * step carries the same idempotency key and gets the first row back instead
 * of a second picture.
 */
export async function saveGeneratedImageArtifact(
  scope: AccessScope,
  artifact: GeneratedImageArtifactInput
) {
  await ensureScope(scope);
  const [inserted] = await db
    .insert(generatedImageArtifacts)
    .values({
      ...artifact,
      createdByUserId: scope.userId,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoNothing({
      target: [
        generatedImageArtifacts.workspaceId,
        generatedImageArtifacts.idempotencyKey,
      ],
    })
    .returning();
  if (inserted) return inserted;
  const existing = await findGeneratedImageArtifact(
    scope,
    artifact.idempotencyKey
  );
  if (!existing) {
    throw new Error("The generated image could not be recorded.");
  }
  return existing;
}

/** The picture one tool call already drew, if any. */
export async function findGeneratedImageArtifact(
  scope: AccessScope,
  idempotencyKey: string
) {
  const rows = await db
    .select()
    .from(generatedImageArtifacts)
    .where(
      and(
        eq(generatedImageArtifacts.workspaceId, scope.workspaceId),
        eq(generatedImageArtifacts.createdByUserId, scope.userId),
        eq(generatedImageArtifacts.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);
  return rows[0];
}

export async function readGeneratedImageArtifact(
  scope: AccessScope,
  artifactId: string,
  options: { readonly rootSessionId?: string } = {}
) {
  const conditions = [
    eq(generatedImageArtifacts.id, artifactId),
    eq(generatedImageArtifacts.workspaceId, scope.workspaceId),
    eq(generatedImageArtifacts.createdByUserId, scope.userId),
  ];
  if (options.rootSessionId) {
    conditions.push(
      eq(generatedImageArtifacts.rootSessionId, options.rootSessionId)
    );
  }
  const rows = await db
    .select()
    .from(generatedImageArtifacts)
    .where(and(...conditions))
    .limit(1);
  return rows[0];
}
