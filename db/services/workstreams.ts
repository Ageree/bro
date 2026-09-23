import { and, count, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { db, workspaces, workstreams } from "@db";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  findWorkstreamsSchema,
  forgetWorkstreamSchema,
  saveWorkstreamSchema,
} from "@shared/workstreams/schema";
import { ensureScope } from "./scope";

export async function findWorkstreams(
  scope: AccessScope,
  scopeKey: string,
  input: z.input<typeof findWorkstreamsSchema>
) {
  const { query, status, offset } = findWorkstreamsSchema.parse(input);
  const pattern = `%${query.replace(/[\\%_]/gu, "\\$&")}%`;
  const rows = await db
    .select()
    .from(workstreams)
    .where(
      and(
        eq(workstreams.workspaceId, scope.workspaceId),
        eq(workstreams.scopeKey, scopeKey),
        isNotNull(workstreams.content),
        status ? sql`${workstreams.content}->>'status' = ${status}` : undefined,
        query
          ? or(
              ilike(workstreams.id, pattern),
              sql`${workstreams.content}::text ILIKE ${pattern}`
            )
          : undefined
      )
    )
    .orderBy(desc(workstreams.updatedAt), workstreams.id)
    .limit(21)
    .offset(offset);
  return {
    items: rows.slice(0, 20).map(workstreamSummary),
    nextOffset: rows.length > 20 ? offset + 20 : null,
  };
}

/**
 * The active index recalled into every interactive turn. Work saved from this
 * session comes first and in full; work from the person's other conversations
 * is reduced to its title, so an unrelated chat is not handed a next step it
 * would feel obliged to report on.
 */
export async function recallWorkstreams(
  scope: AccessScope,
  scopeKey: string,
  sessionId: string
) {
  const inThisSession = sql<boolean>`coalesce(${workstreams.sessionId} = ${sessionId}, false)`;
  const rows = await db
    .select({ inThisSession, workstream: workstreams })
    .from(workstreams)
    .where(
      and(
        eq(workstreams.workspaceId, scope.workspaceId),
        eq(workstreams.scopeKey, scopeKey),
        sql`${workstreams.content}->>'status' IN ('active', 'waiting')`
      )
    )
    .orderBy(desc(inThisSession), desc(workstreams.updatedAt), workstreams.id)
    .limit(9);
  const recalled = rows.slice(0, 8);
  return {
    current: recalled
      .filter((row) => row.inThisSession)
      .map((row) => workstreamSummary(row.workstream)),
    elsewhere: recalled
      .filter((row) => !row.inThisSession)
      .map(({ workstream }) => ({
        id: workstream.id,
        title: workstream.content?.title,
        status: workstream.content?.status,
      })),
    hasMore: rows.length > 8,
  };
}

export async function readWorkstream(
  scope: AccessScope,
  scopeKey: string,
  id: string
) {
  const [row] = await db
    .select()
    .from(workstreams)
    .where(
      and(
        eq(workstreams.workspaceId, scope.workspaceId),
        eq(workstreams.scopeKey, scopeKey),
        eq(workstreams.id, id),
        isNotNull(workstreams.content)
      )
    )
    .limit(1);
  return row ? workstreamResult(row) : null;
}

export async function saveWorkstream(
  scope: AccessScope,
  scopeKey: string,
  input: z.infer<typeof saveWorkstreamSchema>,
  operationId: string,
  sessionId: string
) {
  const { id, expectedRevision, content } = saveWorkstreamSchema.parse(input);
  await ensureScope(scope);
  return db.transaction(async (transaction) => {
    // Serialize capacity checks and writes for this workspace, including new IDs.
    await transaction
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, scope.workspaceId))
      .for("update");
    const identity = and(
      eq(workstreams.workspaceId, scope.workspaceId),
      eq(workstreams.scopeKey, scopeKey),
      eq(workstreams.id, id)
    );
    const [current] = await transaction
      .select()
      .from(workstreams)
      .where(identity)
      .limit(1);
    if (current?.lastOperationId === operationId)
      return workstreamResult(current);
    if (
      (current?.revision ?? 0) !== expectedRevision ||
      current?.content === null
    ) {
      throw new Error(
        "Workstream changed or was forgotten. Read it again and reconcile your update; use a new ID for a forgotten workstream."
      );
    }
    if (!current) {
      const [total] = await transaction
        .select({ value: count() })
        .from(workstreams)
        .where(
          and(
            eq(workstreams.workspaceId, scope.workspaceId),
            eq(workstreams.scopeKey, scopeKey),
            isNotNull(workstreams.content)
          )
        );
      if ((total?.value ?? 0) >= 100)
        throw new Error(
          "Workstream memory is full (100 records). Ask which obsolete workstream to forget before adding another."
        );
    }
    const values = {
      content,
      lastOperationId: operationId,
      revision: expectedRevision + 1,
      sessionId,
      updatedAt: new Date(),
    };
    const [saved] = current
      ? await transaction
          .update(workstreams)
          .set(values)
          .where(
            and(
              identity,
              eq(workstreams.revision, expectedRevision),
              isNotNull(workstreams.content)
            )
          )
          .returning()
      : await transaction
          .insert(workstreams)
          .values({ ...values, id, scopeKey, workspaceId: scope.workspaceId })
          .returning();
    if (!saved) throw new Error("The workstream could not be saved.");
    return workstreamResult(saved);
  });
}

export async function forgetWorkstream(
  scope: AccessScope,
  scopeKey: string,
  input: z.infer<typeof forgetWorkstreamSchema>,
  operationId: string
) {
  const { id, expectedRevision } = forgetWorkstreamSchema.parse(input);
  await ensureScope(scope);
  return db.transaction(async (transaction) => {
    // Use the same lock as saves so forgetting also fences a delayed initial create.
    await transaction
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, scope.workspaceId))
      .for("update");
    const identity = and(
      eq(workstreams.workspaceId, scope.workspaceId),
      eq(workstreams.scopeKey, scopeKey),
      eq(workstreams.id, id)
    );
    const [current] = await transaction
      .select()
      .from(workstreams)
      .where(identity)
      .limit(1);
    if (current?.content === null) return { forgotten: true };
    if (current && current.revision !== expectedRevision) {
      throw new Error(
        "Workstream changed. Read the current revision before forgetting it."
      );
    }
    // Retain only a tombstone, including when a save for this ID has not arrived yet.
    const values = {
      content: null,
      sessionId: null,
      revision: (current?.revision ?? 0) + 1,
      lastOperationId: operationId,
      updatedAt: new Date(),
    };
    if (current) {
      await transaction.update(workstreams).set(values).where(identity);
    } else {
      await transaction
        .insert(workstreams)
        .values({ ...values, id, scopeKey, workspaceId: scope.workspaceId });
    }
    return { forgotten: true };
  });
}

function workstreamResult(row: typeof workstreams.$inferSelect) {
  return {
    id: row.id,
    revision: row.revision,
    content: row.content,
    sessionId: row.sessionId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function workstreamSummary(row: typeof workstreams.$inferSelect) {
  return {
    id: row.id,
    revision: row.revision,
    title: row.content?.title,
    objective: row.content?.objective,
    status: row.content?.status,
    nextStep: row.content?.nextStep,
  };
}
