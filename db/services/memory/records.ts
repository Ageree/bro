import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
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
  comparableMemoryText,
  findMemorySchema,
  isSafeMemoryText,
  type MemoryContent,
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
/** A profile moved from the scope keys eve used before to the pinned one. */
const adoption: MemoryOrigin = { actor: "system" };

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

/** The eve scope keys a workspace keeps profile memory under. */
export async function listMemoryScopeKeys(workspaceId: string) {
  const rows = await db
    .select({ scopeKey: memoryScopes.scopeKey })
    .from(memoryScopes)
    .where(eq(memoryScopes.workspaceId, workspaceId))
    .orderBy(asc(memoryScopes.scopeKey));
  return rows.map(({ scopeKey }) => scopeKey);
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
  input: {
    index: number;
    expectedRevision?: number;
    /** A record this one folds into, which must still be at that revision. */
    keeper?: { readonly index: number; readonly revision: number };
  },
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
    if (input.keeper) {
      // Locked, as below: the text this one folds into stays what was read
      // until the forget commits.
      const [keeper] = await transaction
        .select({ revision: memoryRecords.revision })
        .from(memoryRecords)
        .where(
          and(
            recordIdentity(scope, scopeKey, input.keeper.index),
            isNotNull(memoryRecords.content)
          )
        )
        .limit(1)
        .for("update");
      if (keeper?.revision !== input.keeper.revision) {
        throw new Error(
          "Memory changed: what it folds into is not what was read."
        );
      }
    }
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

/**
 * Moves the current records of the scopes `fromKeys` (oldest first) into
 * `toKey`: the profile a slot kept under other eve scope keys. A record the
 * target already holds (same category and text, as `comparableMemoryText`
 * reads it) is merged into it instead: the longer validity, both sets of
 * aliases, and `localOnly` if either copy asked for it. Rules go first, and
 * whatever does not fit under the cap stays put for a later call, while a
 * copy of what a full profile holds still merges into it. Each move keeps the
 * record's origin and dates,
 * takes the target's next index (related indexes follow it), joins the
 * semantic index queue, and retires the source as forgetting would, so a
 * repeated call finds nothing to move. History sees each step as `system`:
 * an `import` in the target, a `merge` for the copy it folded and for the
 * source it retired. The number of records moved.
 */
export async function adoptMemoryRecords(
  scope: AccessScope,
  fromKeys: readonly string[],
  toKey: string
) {
  const currentIn = (keys: readonly string[]) =>
    and(
      eq(memoryRecords.workspaceId, scope.workspaceId),
      inArray(memoryRecords.scopeKey, [...keys]),
      isNotNull(memoryRecords.content),
      currentValidity()
    );
  // Nearly every call ends here: one indexed lookup.
  const [pending] = await db
    .select({ index: memoryRecords.index })
    .from(memoryRecords)
    .where(currentIn(fromKeys))
    .limit(1);
  if (!pending) return 0;
  // Even a full target takes the transaction: a duplicate still merges into
  // the record the target holds, `localOnly` included; only new records wait
  // for room.
  await ensureMemoryScope(scope, toKey);
  return db.transaction(async (transaction) => {
    await lockScope(transaction, scope, toKey);
    await transaction
      .select({ scopeKey: memoryScopes.scopeKey })
      .from(memoryScopes)
      .where(
        and(
          eq(memoryScopes.workspaceId, scope.workspaceId),
          inArray(memoryScopes.scopeKey, [...fromKeys])
        )
      )
      .for("update");
    const current = (keys: readonly string[]) =>
      transaction
        .select()
        .from(memoryRecords)
        .where(currentIn(keys))
        .orderBy(asc(memoryRecords.index));
    const [sources, kept, [target]] = await Promise.all([
      current(fromKeys),
      current([toKey]),
      transaction
        .select()
        .from(memoryScopes)
        .where(scopeIdentity(scope, toKey))
        .limit(1),
    ]);
    if (!target) throw new Error("Memory scope could not be initialized.");
    type Row = (typeof sources)[number];
    interface Held {
      content: MemoryContent;
      index: number;
      row?: Row;
    }
    // Each memory once: what the target holds, then what moves into it.
    const held = new Map(
      kept.flatMap((row): [string, Held][] =>
        row.content
          ? [
              [
                sameAs(row.content),
                { content: row.content, index: row.index, row },
              ],
            ]
          : []
      )
    );
    const indexes = new Map<string, number>();
    const moved: { held: Held; row: Row }[] = [];
    const retired: Row[] = [];
    let room = maximumRecords - kept.length;
    let lastIndex = target.lastAllocatedIndex;
    const age = new Map(fromKeys.map((key, position) => [key, position]));
    const ordered = sources.toSorted(
      (left, right) =>
        Number(isRule(right.content)) - Number(isRule(left.content)) ||
        (age.get(left.scopeKey) ?? 0) - (age.get(right.scopeKey) ?? 0) ||
        left.index - right.index
    );
    for (const row of ordered) {
      if (!row.content) continue;
      const same = held.get(sameAs(row.content));
      if (same) {
        indexes.set(sourceIndex(row.scopeKey, row.index), same.index);
        same.content = mergedContent(same.content, row.content);
        retired.push(row);
        continue;
      }
      if (room <= 0) continue;
      room -= 1;
      lastIndex += 1;
      const added = { content: row.content, index: lastIndex };
      indexes.set(sourceIndex(row.scopeKey, row.index), lastIndex);
      held.set(sameAs(row.content), added);
      moved.push({ held: added, row });
      retired.push(row);
    }
    if (retired.length === 0) return 0;

    const now = new Date();
    for (const { held: adopted, row } of moved) {
      const relatedIndexes = [
        ...new Set(
          adopted.content.relatedIndexes.flatMap((related) => {
            const index = indexes.get(sourceIndex(row.scopeKey, related));
            return index === undefined || index === adopted.index
              ? []
              : [index];
          })
        ),
      ];
      // oxlint-disable-next-line eslint/no-await-in-loop -- One transaction: its statements run one after another anyway.
      const [saved] = await transaction
        .insert(memoryRecords)
        .values({
          content: { ...adopted.content, relatedIndexes },
          createdAt: row.createdAt,
          generation: target.generation,
          index: adopted.index,
          lastOperationId: `adopt:${row.scopeKey}:${String(row.index)}`,
          revision: 1,
          scopeKey: toKey,
          sourceSessionId: row.sourceSessionId,
          sourceTurnId: row.sourceTurnId,
          updatedAt: row.updatedAt,
          workspaceId: scope.workspaceId,
        })
        .returning();
      if (!saved) throw new Error("Memory could not be adopted.");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Same transaction as the insert above.
      await recordRevision(transaction, saved, adoption, "import");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Same transaction as the insert above.
      await enqueueSync(transaction, saved);
    }
    // A record the target held, merged with its copy: saved as an update is.
    for (const { content, index, row } of held.values()) {
      if (!row || content === row.content) continue;
      // oxlint-disable-next-line eslint/no-await-in-loop -- One transaction: its statements run one after another anyway.
      const [saved] = await transaction
        .update(memoryRecords)
        .set({
          content,
          lastOperationId: `adopt:merge:${String(index)}:${String(row.revision + 1)}`,
          revision: row.revision + 1,
          updatedAt: now,
        })
        .where(
          and(
            recordIdentity(scope, toKey, index),
            eq(memoryRecords.revision, row.revision)
          )
        )
        .returning();
      if (!saved) throw new Error("Memory could not be adopted.");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Same transaction as the update above.
      await recordRevision(transaction, saved, adoption, "merge");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Same transaction as the update above.
      await transaction
        .update(memorySync)
        .set(syncRemoval(now))
        .where(
          and(
            eq(memorySync.workspaceId, scope.workspaceId),
            eq(memorySync.scopeKey, toKey),
            eq(memorySync.recordIndex, index)
          )
        );
      // oxlint-disable-next-line eslint/no-await-in-loop -- Same transaction as the update above.
      await enqueueSync(transaction, saved);
    }
    await transaction
      .update(memoryScopes)
      .set({ lastAllocatedIndex: lastIndex, updatedAt: now })
      .where(scopeIdentity(scope, toKey));
    // The text lives on in the target, so a source keeps its history as a
    // merge does, for 30 days.
    await Promise.all(
      retired.map(async (row) => {
        const [gone] = await transaction
          .update(memoryRecords)
          .set({
            content: null,
            lastOperationId: `adopted:${toKey}:${String(row.index)}`,
            revision: row.revision + 1,
            sourceSessionId: null,
            sourceTurnId: null,
            updatedAt: now,
          })
          .where(
            and(
              recordIdentity(scope, row.scopeKey, row.index),
              eq(memoryRecords.revision, row.revision)
            )
          )
          .returning();
        if (gone) await recordRevision(transaction, gone, adoption, "merge");
      })
    );
    await Promise.all(
      fromKeys.flatMap((key) => {
        const gone = retired.flatMap((row) =>
          row.scopeKey === key ? [row.index] : []
        );
        return gone.length === 0
          ? []
          : transaction
              .update(memorySync)
              .set(syncRemoval(now))
              .where(
                and(
                  eq(memorySync.workspaceId, scope.workspaceId),
                  eq(memorySync.scopeKey, key),
                  inArray(memorySync.recordIndex, gone)
                )
              );
      })
    );
    return moved.length;
  });
}

/** A record of one of the scopes being adopted: its scope key and index. */
function sourceIndex(scopeKey: string, index: number) {
  return `${scopeKey}\0${String(index)}`;
}

function isRule(content: MemoryContent | null) {
  return content?.category === "rule";
}

/** What makes two records the same memory: category and comparable text. */
function sameAs(content: MemoryContent) {
  return `${content.category}\0${comparableMemoryText(content.text)}`;
}

/**
 * One memory saved twice, as one record: `base` with the other copy's aliases
 * added, the validity that lasts longer, and `localOnly` if either asked to
 * keep it out of the semantic index. `base` itself when nothing changes.
 */
function mergedContent(base: MemoryContent, copy: MemoryContent) {
  const aliases = [...new Set([...base.aliases, ...copy.aliases])].slice(0, 12);
  const validUntil =
    base.validUntil === null || copy.validUntil === null
      ? null
      : Date.parse(copy.validUntil) > Date.parse(base.validUntil)
        ? copy.validUntil
        : base.validUntil;
  const localOnly = base.localOnly || copy.localOnly;
  return aliases.length === base.aliases.length &&
    validUntil === base.validUntil &&
    localOnly === base.localOnly
    ? base
    : { ...base, aliases, localOnly, validUntil };
}

/** A semantic index entry queued to leave the index. */
function syncRemoval(now: Date) {
  return {
    attempts: 0,
    desiredPresent: false,
    leaseUntil: null,
    nextAttemptAt: now,
    status: "pending" as const,
    updatedAt: now,
  };
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
    -- Locked as a forget locks it: a record forgotten meanwhile is read
    -- again, without its text, and one being forgotten is left for the
    -- next tick.
    FOR UPDATE OF record SKIP LOCKED
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
