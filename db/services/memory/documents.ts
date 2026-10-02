import { and, eq, sql } from "drizzle-orm";
import { db, memoryDocuments } from "@db";

/** eve's memory document for a scope key, or undefined when there is none. */
export async function readMemoryDocument(scopeKey: string) {
  const [row] = await db
    .select({
      content: memoryDocuments.content,
      version: memoryDocuments.version,
    })
    .from(memoryDocuments)
    .where(eq(memoryDocuments.scopeKey, scopeKey))
    .limit(1);
  return row;
}

/**
 * Writes a scope's document only if it is still the version the writer read
 * (`expectedVersion`), or, with null, only if there is none yet. The new
 * version, or undefined when another writer got there first.
 */
export async function writeMemoryDocument(input: {
  readonly content: string;
  readonly expectedVersion: number | null;
  readonly scopeKey: string;
}) {
  const [row] =
    input.expectedVersion === null
      ? await db
          .insert(memoryDocuments)
          .values({ content: input.content, scopeKey: input.scopeKey })
          .onConflictDoNothing()
          .returning({ version: memoryDocuments.version })
      : await db
          .update(memoryDocuments)
          .set({
            content: input.content,
            updatedAt: new Date(),
            version: sql`${memoryDocuments.version} + 1`,
          })
          .where(
            and(
              eq(memoryDocuments.scopeKey, input.scopeKey),
              eq(memoryDocuments.version, input.expectedVersion)
            )
          )
          .returning({ version: memoryDocuments.version });
  return row?.version;
}
