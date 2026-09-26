import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  isNotNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { z } from "zod";
import {
  db,
  memoryOperations,
  memoryRecords,
  memoryScopes,
  memorySync,
  workspaces,
} from "@db";
import { ensureScope } from "@db/services/scope";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  findMemorySchema,
  isSafeMemoryText,
  memoryContentSchema,
  saveMemorySchema,
  updateMemorySchema,
} from "@shared/memory/schema";

const maximumRecords = 250;

async function ensureMemoryScope(scope: AccessScope, scopeKey: string) {
  await ensureScope(scope);
  await db
    .insert(memoryScopes)
    .values({ scopeKey, workspaceId: scope.workspaceId })
    .onConflictDoNothing();
}

export async function listCurrentMemories(
  scope: AccessScope,
  scopeKey: string,
  limit = 250
) {
  const now = new Date();
  const rows = await db
    .select()
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, scope.workspaceId),
        eq(memoryRecords.scopeKey, scopeKey),
        isNotNull(memoryRecords.content),
        or(
          sql`${memoryRecords.content}->>'validUntil' IS NULL`,
          sql`(${memoryRecords.content}->>'validUntil')::timestamptz > ${now}`
        )
      )
    )
    .orderBy(asc(memoryRecords.index))
    .limit(limit);
  return rows.map(memoryResult);
}

/**
 * The texts of the rules the person set, from every memory scope of the
 * workspace: a tool outside the memory provider has no scope key, and a
 * rule binds Bro in every conversation.
 */
export async function listCurrentRuleTexts(scope: AccessScope) {
  const now = new Date();
  const rows = await db
    .select({ content: memoryRecords.content })
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, scope.workspaceId),
        sql`${memoryRecords.content}->>'category' = 'rule'`,
        or(
          sql`${memoryRecords.content}->>'validUntil' IS NULL`,
          sql`(${memoryRecords.content}->>'validUntil')::timestamptz > ${now}`
        )
      )
    )
    .limit(maximumRecords);
  return rows.flatMap((row) => (row.content ? [row.content.text] : []));
}

export async function findMemories(
  scope: AccessScope,
  scopeKey: string,
  input: z.input<typeof findMemorySchema>
) {
  const { query, category, offset } = findMemorySchema.parse(input);
  const pattern = `%${query.replace(/[\\%_]/gu, "\\$&")}%`;
  const rows = await db
    .select()
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, scope.workspaceId),
        eq(memoryRecords.scopeKey, scopeKey),
        isNotNull(memoryRecords.content),
        category
          ? sql`${memoryRecords.content}->>'category' = ${category}`
          : undefined,
        query
          ? or(
              ilike(sql`${memoryRecords.content}->>'text'`, pattern),
              sql`(${memoryRecords.content}->'aliases')::text ILIKE ${pattern}`
            )
          : undefined,
        or(
          sql`${memoryRecords.content}->>'validUntil' IS NULL`,
          sql`(${memoryRecords.content}->>'validUntil')::timestamptz > now()`
        )
      )
    )
    .orderBy(desc(memoryRecords.updatedAt), memoryRecords.index)
    .limit(21)
    .offset(offset);
  return {
    items: rows.slice(0, 20).map(memoryResult),
    nextOffset: rows.length > 20 ? offset + 20 : null,
  };
}

export async function readMemory(
  scope: AccessScope,
  scopeKey: string,
  index: number
) {
  const [row] = await db
    .select()
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, scope.workspaceId),
        eq(memoryRecords.scopeKey, scopeKey),
        eq(memoryRecords.index, index),
        isNotNull(memoryRecords.content),
        currentValidity()
      )
    )
    .limit(1);
  return row ? memoryResult(row) : null;
}

/**
 * What a current memory says and which conversation saved it, or null when
 * there is no such memory. Forgetting one another conversation saved
 * is the person's to confirm.
 */
export async function readMemorySource(
  scope: AccessScope,
  scopeKey: string,
  index: number
) {
  const [row] = await db
    .select({
      content: memoryRecords.content,
      sourceSessionId: memoryRecords.sourceSessionId,
    })
    .from(memoryRecords)
    .where(
      and(
        recordIdentity(scope, scopeKey, index),
        isNotNull(memoryRecords.content),
        currentValidity()
      )
    )
    .limit(1);
  return row?.content
    ? {
        category: row.content.category,
        sourceSessionId: row.sourceSessionId,
        text: row.content.text,
      }
    : null;
}

export async function saveMemory(
  scope: AccessScope,
  scopeKey: string,
  input: z.input<typeof saveMemorySchema>,
  operationId: string,
  source: { sessionId: string; turnId: string }
) {
  const content = memoryContentSchema.parse(saveMemorySchema.parse(input));
  await ensureMemoryScope(scope, scopeKey);
  return db.transaction(async (transaction) => {
    await lockScope(transaction, scope, scopeKey);
    const replay = await readOperation(
      transaction,
      scope,
      scopeKey,
      operationId
    );
    if (replay) return replay;

    const [duplicate] = await transaction
      .select()
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.workspaceId, scope.workspaceId),
          eq(memoryRecords.scopeKey, scopeKey),
          isNotNull(memoryRecords.content),
          sql`lower(${memoryRecords.content}->>'text') = lower(${content.text})`,
          currentValidity()
        )
      )
      .limit(1);
    if (duplicate) {
      await recordOperation(transaction, scope, scopeKey, operationId, {
        action: "save",
        index: duplicate.index,
        revision: duplicate.revision,
      });
      return { index: duplicate.index, revision: duplicate.revision };
    }

    const [scopeRow] = await transaction
      .select()
      .from(memoryScopes)
      .where(scopeIdentity(scope, scopeKey))
      .limit(1);
    if (!scopeRow) throw new Error("Memory scope could not be initialized.");
    const [total] = await transaction
      .select({ count: sql<number>`count(*)::int` })
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.workspaceId, scope.workspaceId),
          eq(memoryRecords.scopeKey, scopeKey),
          isNotNull(memoryRecords.content),
          currentValidity()
        )
      );
    if ((total?.count ?? 0) >= maximumRecords) {
      throw new Error(
        `Profile memory is full (${maximumRecords.toLocaleString("en-US")} records). Forget an obsolete memory before adding another.`
      );
    }

    const index = scopeRow.lastAllocatedIndex + 1;
    const [saved] = await transaction
      .insert(memoryRecords)
      .values({
        content,
        generation: scopeRow.generation,
        index,
        lastOperationId: operationId,
        revision: 1,
        scopeKey,
        sourceSessionId: source.sessionId,
        sourceTurnId: source.turnId,
        workspaceId: scope.workspaceId,
      })
      .returning();
    await transaction
      .update(memoryScopes)
      .set({ lastAllocatedIndex: index, updatedAt: new Date() })
      .where(scopeIdentity(scope, scopeKey));
    await recordOperation(transaction, scope, scopeKey, operationId, {
      action: "save",
      index,
      revision: 1,
    });
    if (!saved) throw new Error("Memory could not be saved.");
    await enqueueSync(transaction, saved);
    return { index: saved.index, revision: saved.revision };
  });
}

/**
 * Replaces a memory's content. The record keeps the conversation that saved
 * it: a correction here does not make an older memory this conversation's
 * own, which would let an update followed by a removal forget it without the
 * person's confirmation.
 */
export async function updateMemory(
  scope: AccessScope,
  scopeKey: string,
  input: z.input<typeof updateMemorySchema>,
  operationId: string
) {
  const parsed = updateMemorySchema.parse(input);
  await ensureMemoryScope(scope, scopeKey);
  return db.transaction(async (transaction) => {
    await lockScope(transaction, scope, scopeKey);
    const replay = await readOperation(
      transaction,
      scope,
      scopeKey,
      operationId
    );
    if (replay) return replay;
    const identity = recordIdentity(scope, scopeKey, parsed.index);
    const [saved] = await transaction
      .update(memoryRecords)
      .set({
        content: parsed.content,
        lastOperationId: operationId,
        revision: parsed.expectedRevision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          identity,
          eq(memoryRecords.revision, parsed.expectedRevision),
          isNotNull(memoryRecords.content)
        )
      )
      .returning();
    if (!saved) {
      throw new Error(
        "Memory changed or was forgotten. Read its current revision before updating it."
      );
    }
    await recordOperation(transaction, scope, scopeKey, operationId, {
      action: "update",
      index: saved.index,
      revision: saved.revision,
    });
    await transaction
      .update(memorySync)
      .set({
        attempts: 0,
        desiredPresent: false,
        leaseUntil: null,
        nextAttemptAt: new Date(),
        status: "pending",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(memorySync.workspaceId, scope.workspaceId),
          eq(memorySync.scopeKey, scopeKey),
          eq(memorySync.recordIndex, saved.index)
        )
      );
    await enqueueSync(transaction, saved);
    return { index: saved.index, revision: saved.revision };
  });
}

export async function forgetMemory(
  scope: AccessScope,
  scopeKey: string,
  input: { index: number; expectedRevision?: number },
  operationId: string
) {
  await ensureMemoryScope(scope, scopeKey);
  return db.transaction(async (transaction) => {
    await lockScope(transaction, scope, scopeKey);
    const replay = await readOperation(
      transaction,
      scope,
      scopeKey,
      operationId
    );
    if (replay) return { forgotten: true, ...replay };
    const identity = recordIdentity(scope, scopeKey, input.index);
    const [current] = await transaction
      .select()
      .from(memoryRecords)
      .where(identity)
      .limit(1);
    if (current?.content === null) {
      const now = new Date();
      await transaction
        .update(memorySync)
        .set({
          attempts: 0,
          desiredPresent: false,
          leaseUntil: null,
          nextAttemptAt: now,
          status: "pending",
          updatedAt: now,
        })
        .where(
          and(
            eq(memorySync.workspaceId, scope.workspaceId),
            eq(memorySync.scopeKey, scopeKey),
            eq(memorySync.recordIndex, input.index)
          )
        );
      return {
        forgotten: true,
        index: input.index,
        revision: current.revision,
      };
    }
    if (
      current &&
      input.expectedRevision !== undefined &&
      current.revision !== input.expectedRevision
    ) {
      throw new Error(
        "Memory changed. Read its current revision before forgetting it."
      );
    }
    if (!current) return { forgotten: true };
    const revision = current.revision + 1;
    const values = {
      content: null,
      lastOperationId: operationId,
      revision,
      sourceSessionId: null,
      sourceTurnId: null,
      updatedAt: new Date(),
    };
    await transaction.update(memoryRecords).set(values).where(identity);
    await recordOperation(transaction, scope, scopeKey, operationId, {
      action: "forget",
      index: input.index,
      revision,
    });
    await transaction
      .update(memorySync)
      .set({
        attempts: 0,
        desiredPresent: false,
        leaseUntil: null,
        nextAttemptAt: new Date(),
        status: "pending",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(memorySync.workspaceId, scope.workspaceId),
          eq(memorySync.scopeKey, scopeKey),
          eq(memorySync.recordIndex, input.index)
        )
      );
    return { forgotten: true, index: input.index, revision };
  });
}

export async function expireMemories(now = new Date()) {
  return db.transaction(async (transaction) => {
    const expired = await transaction
      .update(memoryRecords)
      .set({
        content: null,
        lastOperationId: sql`'expiry:' || ${memoryRecords.index}::text || ':' || (${memoryRecords.revision} + 1)::text`,
        revision: sql`${memoryRecords.revision} + 1`,
        sourceSessionId: null,
        sourceTurnId: null,
        updatedAt: now,
      })
      .where(
        and(
          isNotNull(memoryRecords.content),
          sql`${memoryRecords.content}->>'validUntil' IS NOT NULL`,
          lte(sql`(${memoryRecords.content}->>'validUntil')::timestamptz`, now)
        )
      )
      .returning({
        index: memoryRecords.index,
        scopeKey: memoryRecords.scopeKey,
        workspaceId: memoryRecords.workspaceId,
      });
    await Promise.all(
      expired.map((row) =>
        transaction
          .update(memorySync)
          .set({
            attempts: 0,
            desiredPresent: false,
            leaseUntil: null,
            nextAttemptAt: now,
            status: "pending",
            updatedAt: now,
          })
          .where(
            and(
              eq(memorySync.workspaceId, row.workspaceId),
              eq(memorySync.scopeKey, row.scopeKey),
              eq(memorySync.recordIndex, row.index)
            )
          )
      )
    );
    return expired;
  });
}

export async function importLegacyMemories(
  scope: AccessScope,
  scopeKey: string,
  entries: readonly { index: number; text: string }[],
  lastAllocatedIndex: number
) {
  await ensureMemoryScope(scope, scopeKey);
  return db.transaction(async (transaction) => {
    await lockScope(transaction, scope, scopeKey);
    const [state] = await transaction
      .select()
      .from(memoryScopes)
      .where(scopeIdentity(scope, scopeKey))
      .limit(1);
    if (!state || state.legacyImportCompletedAt) return false;
    await Promise.all(
      entries
        .filter((entry) => isSafeMemoryText(entry.text))
        .map((entry) =>
          transaction
            .insert(memoryRecords)
            .values({
              content: memoryContentSchema.parse({
                aliases: [],
                category: "fact",
                localOnly: true,
                relatedIndexes: [],
                text: entry.text,
                validUntil: null,
              }),
              generation: state.generation,
              index: entry.index,
              lastOperationId: `legacy-import:${String(entry.index)}`,
              revision: 1,
              scopeKey,
              workspaceId: scope.workspaceId,
            })
            .onConflictDoNothing()
        )
    );
    await transaction
      .update(memoryScopes)
      .set({
        lastAllocatedIndex: Math.max(
          state.lastAllocatedIndex,
          lastAllocatedIndex
        ),
        legacyImportCompletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(scopeIdentity(scope, scopeKey));
    return true;
  });
}

export async function memoryScopeNeedsLegacyImport(
  scope: AccessScope,
  scopeKey: string
) {
  await ensureMemoryScope(scope, scopeKey);
  const [state] = await db
    .select({ completedAt: memoryScopes.legacyImportCompletedAt })
    .from(memoryScopes)
    .where(scopeIdentity(scope, scopeKey))
    .limit(1);
  return state?.completedAt === null;
}

export async function semanticMemoryEnabled(
  scope: AccessScope,
  scopeKey: string
) {
  const [state] = await db
    .select({ enabled: memoryScopes.semanticIndexEnabled })
    .from(memoryScopes)
    .where(scopeIdentity(scope, scopeKey))
    .limit(1);
  return state?.enabled === true;
}

function memoryResult(row: typeof memoryRecords.$inferSelect) {
  return {
    content: row.content,
    index: row.index,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function scopeIdentity(scope: AccessScope, scopeKey: string) {
  return and(
    eq(memoryScopes.workspaceId, scope.workspaceId),
    eq(memoryScopes.scopeKey, scopeKey)
  );
}

function recordIdentity(scope: AccessScope, scopeKey: string, index: number) {
  return and(
    eq(memoryRecords.workspaceId, scope.workspaceId),
    eq(memoryRecords.scopeKey, scopeKey),
    eq(memoryRecords.index, index)
  );
}

async function lockScope(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  scope: AccessScope,
  scopeKey: string
) {
  await transaction
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, scope.workspaceId))
    .for("update");
  await transaction
    .select({ scopeKey: memoryScopes.scopeKey })
    .from(memoryScopes)
    .where(scopeIdentity(scope, scopeKey))
    .for("update");
}

async function readOperation(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  scope: AccessScope,
  scopeKey: string,
  operationId: string
) {
  const [operation] = await transaction
    .select()
    .from(memoryOperations)
    .where(
      and(
        eq(memoryOperations.workspaceId, scope.workspaceId),
        eq(memoryOperations.scopeKey, scopeKey),
        eq(memoryOperations.operationId, operationId)
      )
    )
    .limit(1);
  return operation
    ? { index: operation.recordIndex, revision: operation.revision }
    : null;
}

function recordOperation(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  scope: AccessScope,
  scopeKey: string,
  operationId: string,
  result: { action: string; index: number; revision: number }
) {
  return transaction.insert(memoryOperations).values({
    action: result.action,
    operationId,
    recordIndex: result.index,
    revision: result.revision,
    scopeKey,
    workspaceId: scope.workspaceId,
  });
}

function enqueueSync(
  transaction: Parameters<Parameters<typeof db.transaction>[0]>[0],
  row: typeof memoryRecords.$inferSelect
) {
  return transaction
    .insert(memorySync)
    .values({
      customId: memorySyncCustomId(
        row.workspaceId,
        row.scopeKey,
        row.index,
        row.revision,
        row.generation
      ),
      desiredPresent: row.content !== null && !row.content.localOnly,
      generation: row.generation,
      recordIndex: row.index,
      revision: row.revision,
      scopeKey: row.scopeKey,
      workspaceId: row.workspaceId,
    })
    .onConflictDoNothing();
}

function memorySyncCustomId(
  workspaceId: string,
  scopeKey: string,
  index: number,
  revision: number,
  generation: number
) {
  const identity = [
    workspaceId,
    scopeKey,
    String(index),
    String(revision),
    String(generation),
  ].join(":");
  return `bro-memory-${sqlHash(identity)}`;
}

function sqlHash(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function currentValidity() {
  return or(
    sql`${memoryRecords.content}->>'validUntil' IS NULL`,
    sql`(${memoryRecords.content}->>'validUntil')::timestamptz > now()`
  );
}
