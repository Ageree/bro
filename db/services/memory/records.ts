import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  isNotNull,
  lt,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { z } from "zod";
import {
  db,
  memoryOperations,
  memoryRecords,
  memoryRevisions,
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

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Who wrote a revision and why. The model writes through its memory tools
 * in a conversation; the person, in the cabinet; the daily digest and
 * expiry, on their own.
 */
interface MemoryOrigin {
  readonly actor: (typeof memoryRevisions.$inferInsert)["actor"];
  readonly action?: RevisionAction;
  readonly sessionId?: string;
}

type RevisionAction = (typeof memoryRevisions.$inferInsert)["action"];

const modelOrigin: MemoryOrigin = { actor: "model" };

/**
 * Removals that keep the record's history readable for a while: what the
 * digest merged, corrected or found one-off can be restored. Everything
 * else forgotten — at the person's word, by the model, or a code the digest
 * purged — leaves no text behind.
 */
const removalsKeepingHistory: ReadonlySet<RevisionAction> = new Set([
  "merge",
  "correct",
  "one_off",
]);

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

export async function listCurrentRules(scope: AccessScope) {
  const rows = await db
    .select({ index: memoryRecords.index, content: memoryRecords.content })
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, scope.workspaceId),
        isNotNull(memoryRecords.content),
        sql`${memoryRecords.content}->>'category' = 'rule'`,
        currentValidity()
      )
    )
    .limit(maximumRecords);
  return rows.flatMap(({ index, content }) =>
    content ? [{ index, text: content.text }] : []
  );
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
  source: { sessionId: string; turnId: string },
  origin: MemoryOrigin = { ...modelOrigin, sessionId: source.sessionId }
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
    await recordRevision(transaction, saved, origin, "save");
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
  operationId: string,
  origin: MemoryOrigin = modelOrigin
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
    await recordRevision(transaction, saved, origin, "update");
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
  operationId: string,
  origin: MemoryOrigin = modelOrigin
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
    // Locked: expiry, which takes no scope lock, may not bump the revision
    // this forget is about to write.
    const [current] = await transaction
      .select()
      .from(memoryRecords)
      .where(identity)
      .limit(1)
      .for("update");
    if (current?.content === null) {
      if (!removalsKeepingHistory.has(origin.action ?? "forget")) {
        await wipeRecordHistory(transaction, scope, scopeKey, input.index);
      }
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
    const [forgotten] = await transaction
      .update(memoryRecords)
      .set(values)
      .where(identity)
      .returning();
    await recordOperation(transaction, scope, scopeKey, operationId, {
      action: "forget",
      index: input.index,
      revision,
    });
    if (!removalsKeepingHistory.has(origin.action ?? "forget")) {
      await wipeRecordHistory(transaction, scope, scopeKey, input.index);
    }
    if (forgotten) {
      await recordRevision(transaction, forgotten, origin, "forget");
    }
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
        revision: memoryRecords.revision,
        scopeKey: memoryRecords.scopeKey,
        workspaceId: memoryRecords.workspaceId,
      });
    if (expired.length > 0) {
      await transaction
        .insert(memoryRevisions)
        .values(
          expired.map((row) => ({
            action: "expire" as const,
            actor: "system" as const,
            content: null,
            createdAt: now,
            recordIndex: row.index,
            revision: row.revision,
            scopeKey: row.scopeKey,
            workspaceId: row.workspaceId,
          }))
        )
        .onConflictDoNothing();
    }
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
        .map(async (entry) => {
          const [imported] = await transaction
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
            .returning();
          if (imported) {
            await recordRevision(
              transaction,
              imported,
              { actor: "system" },
              "import"
            );
          }
        })
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

/**
 * Marks the scope as the one Bro's conversations read, at most once an
 * hour: the cabinet shows the memory of the scope recalled last.
 */
export async function markMemoryScopeRecalled(
  scope: AccessScope,
  scopeKey: string,
  now = new Date()
) {
  await db
    .update(memoryScopes)
    .set({ lastRecalledAt: now })
    .where(
      and(
        scopeIdentity(scope, scopeKey),
        or(
          sql`${memoryScopes.lastRecalledAt} IS NULL`,
          lt(
            memoryScopes.lastRecalledAt,
            new Date(now.getTime() - 60 * 60 * 1_000)
          ),
          // Another scope of the workspace was marked later: this one is
          // the one recalled last now.
          sql`${memoryScopes.lastRecalledAt} < (
            SELECT max(other.last_recalled_at) FROM ${memoryScopes} AS other
            WHERE other.workspace_id = ${scope.workspaceId}
          )`
        )
      )
    );
}

/**
 * Wipes what history still keeps of memories that are gone — expired, or
 * removed by the digest — once the person has asked Bro to forget
 * everything: «забудь всё» leaves no text behind, in the profile or in its
 * history.
 */
export async function wipeForgottenMemoryHistory(
  scope: AccessScope,
  scopeKey: string
) {
  await db.delete(memoryRevisions).where(
    and(
      eq(memoryRevisions.workspaceId, scope.workspaceId),
      eq(memoryRevisions.scopeKey, scopeKey),
      notExists(
        db
          .select({ index: memoryRecords.index })
          .from(memoryRecords)
          .where(
            and(
              eq(memoryRecords.workspaceId, memoryRevisions.workspaceId),
              eq(memoryRecords.scopeKey, memoryRevisions.scopeKey),
              eq(memoryRecords.index, memoryRevisions.recordIndex),
              isNotNull(memoryRecords.content),
              currentValidity()
            )
          )
      )
    )
  );
}

/** How long history keeps the text of a memory that expired or the digest removed. */
const removedTextRetentionMs = 30 * 24 * 60 * 60 * 1_000;

/**
 * Wipes what history keeps of memories that are gone: their text stays
 * restorable for 30 days after they expired or the digest removed them,
 * and not at all when code that writes no revision forgot them — a release
 * from before the history, during a rollback or a deploy, which leaves the
 * record at a revision history has no row for.
 */
export async function trimForgottenMemoryHistory(now = new Date()) {
  const keptSince = new Date(now.getTime() - removedTextRetentionMs);
  await db.execute(sql`
    UPDATE ${memoryRevisions} AS history
    SET content = NULL, session_id = NULL
    FROM ${memoryRecords} AS record
    WHERE history.workspace_id = record.workspace_id
      AND history.scope_key = record.scope_key
      AND history.record_index = record.record_index
      AND history.content IS NOT NULL
      AND record.content IS NULL
      AND (
        record.updated_at <= ${keptSince}
        OR NOT EXISTS (
          SELECT 1 FROM ${memoryRevisions} AS latest
          WHERE latest.workspace_id = record.workspace_id
            AND latest.scope_key = record.scope_key
            AND latest.record_index = record.record_index
            AND latest.revision = record.revision
        )
      )
  `);
}

/**
 * Starts the history of memories a release without history saved or
 * changed — during a rollback or a deploy, after the migration that started
 * everyone's: such a write leaves the record at a revision history has no
 * row for.
 */
export async function recordUntrackedMemories() {
  await db.execute(sql`
    INSERT INTO ${memoryRevisions}
      (workspace_id, scope_key, record_index, revision, content, action, actor, created_at)
    SELECT record.workspace_id, record.scope_key, record.record_index,
      record.revision, record.content, 'import', 'system', record.updated_at
    FROM ${memoryRecords} AS record
    WHERE record.content IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ${memoryRevisions} AS latest
        WHERE latest.workspace_id = record.workspace_id
          AND latest.scope_key = record.scope_key
          AND latest.record_index = record.record_index
          AND latest.revision = record.revision
      )
    ON CONFLICT DO NOTHING
  `);
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
  transaction: Transaction,
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
  transaction: Transaction,
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
  transaction: Transaction,
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

function recordRevision(
  transaction: Transaction,
  row: typeof memoryRecords.$inferSelect,
  origin: MemoryOrigin,
  action: RevisionAction
) {
  return transaction.insert(memoryRevisions).values({
    action: origin.action ?? action,
    actor: origin.actor,
    content: row.content,
    createdAt: row.updatedAt,
    recordIndex: row.index,
    revision: row.revision,
    scopeKey: row.scopeKey,
    sessionId: origin.sessionId ?? null,
    workspaceId: row.workspaceId,
  });
}

/** Forgetting leaves no earlier text of the record in its history. */
function wipeRecordHistory(
  transaction: Transaction,
  scope: AccessScope,
  scopeKey: string,
  index: number
) {
  return transaction
    .update(memoryRevisions)
    .set({ content: null, sessionId: null })
    .where(
      and(
        eq(memoryRevisions.workspaceId, scope.workspaceId),
        eq(memoryRevisions.scopeKey, scopeKey),
        eq(memoryRevisions.recordIndex, index),
        isNotNull(memoryRevisions.content)
      )
    );
}

function enqueueSync(
  transaction: Transaction,
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
