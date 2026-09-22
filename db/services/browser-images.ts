import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { browserImageArtifacts, db } from "@db";
import { ensureScope } from "./scope";

type BrowserImageArtifactInsert = typeof browserImageArtifacts.$inferInsert;

/**
 * A ready artifact carries its bytes' facts by construction: the row is only
 * written once the image sits in the Blob store, so the columns the schema
 * leaves nullable for a pending row are required here.
 */
type ReadyBrowserImageArtifactInput = Omit<
  BrowserImageArtifactInsert,
  | "byteSize"
  | "contentHash"
  | "createdAt"
  | "createdByUserId"
  | "filename"
  | "id"
  | "mediaType"
  | "status"
  | "workspaceId"
> & {
  readonly byteSize: number;
  readonly contentHash: string;
  readonly filename: string;
  readonly mediaType: string;
};

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

/**
 * Record an image that is already in the Blob store as a ready artifact. The
 * idempotency key is unique per workspace, so a second write of the same
 * capture — a retried completion, two settlers racing — hands back the row
 * the first one made instead of a duplicate the person would see twice.
 */
export async function createReadyBrowserImageArtifact(
  scope: AccessScope,
  input: ReadyBrowserImageArtifactInput
) {
  await ensureScope(scope);
  const [inserted] = await db
    .insert(browserImageArtifacts)
    .values({
      ...input,
      createdByUserId: scope.userId,
      status: "ready",
      workspaceId: scope.workspaceId,
    })
    .onConflictDoNothing({
      target: [
        browserImageArtifacts.workspaceId,
        browserImageArtifacts.idempotencyKey,
      ],
    })
    .returning();
  if (inserted) return inserted;
  const rows = await db
    .select()
    .from(browserImageArtifacts)
    .where(
      and(
        eq(browserImageArtifacts.workspaceId, scope.workspaceId),
        eq(browserImageArtifacts.idempotencyKey, input.idempotencyKey)
      )
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) {
    throw new Error("The browser image artifact could not be recorded.");
  }
  return existing;
}
