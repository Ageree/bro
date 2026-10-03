import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import type { z } from "zod";
import { db, workspaces, workstreams } from "@db";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  findWorkstreamsSchema,
  forgetWorkstreamSchema,
  saveWorkstreamSchema,
} from "@shared/workstreams/schema";
import { ensureScope } from "./scope";

const maximumWorkstreams = 100;

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
 * The active index recalled into every interactive turn. Work started in this
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
      if ((total?.value ?? 0) >= maximumWorkstreams)
        throw new Error(
          "Workstream memory is full (100 records). Ask which obsolete workstream to forget before adding another."
        );
    }
    // An update keeps the conversation the work was started in: saving it
    // here does not make it this conversation's own, which would let a save
    // followed by `forget` erase it without the person's confirmation.
    const values = {
      content,
      lastOperationId: operationId,
      revision: expectedRevision + 1,
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
          .values({
            ...values,
            id,
            scopeKey,
            sessionId,
            workspaceId: scope.workspaceId,
          })
          .returning();
    if (!saved) throw new Error("The workstream could not be saved.");
    return workstreamResult(saved);
  });
}

/** Every live workstream of a workspace, under any scope key. */
export async function listWorkspaceWorkstreams(workspaceId: string) {
  const rows = await db
    .select()
    .from(workstreams)
    .where(
      and(
        eq(workstreams.workspaceId, workspaceId),
        isNotNull(workstreams.content)
      )
    )
    .orderBy(workstreams.scopeKey, workstreams.id);
  return rows.flatMap(({ content, id, revision, scopeKey, sessionId }) =>
    content ? [{ content, id, revision, scopeKey, sessionId }] : []
  );
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

/**
 * Moves the saved work of the scopes `fromKeys` into `toKey`: what a slot kept
 * under other eve scope keys. Work the target already holds word for word is
 * only retired; an ID the target already uses, even by forgotten work, gets a
 * numbered suffix, so neither side is overwritten. The newest work moves
 * first, and whatever does not fit under the cap stays put for a later call,
 * while a copy of what a full target holds is still retired. Each move keeps
 * its conversation and date
 * and retires the source as forgetting would, so a repeated call finds
 * nothing to move. The number of workstreams moved.
 */
export async function adoptWorkstreams(
  scope: AccessScope,
  fromKeys: readonly string[],
  toKey: string
) {
  // Nearly every call ends here: one indexed lookup.
  const [pending] = await db
    .select({ id: workstreams.id })
    .from(workstreams)
    .where(
      and(
        eq(workstreams.workspaceId, scope.workspaceId),
        inArray(workstreams.scopeKey, [...fromKeys]),
        isNotNull(workstreams.content)
      )
    )
    .limit(1);
  if (!pending) return 0;
  // Even a full target takes the transaction: an identical entry is still
  // retired, only new work waits for room.
  await ensureScope(scope);
  return db.transaction(async (transaction) => {
    // The lock every save and forget takes.
    await transaction
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, scope.workspaceId))
      .for("update");
    const [sources, targets] = await Promise.all([
      transaction
        .select()
        .from(workstreams)
        .where(
          and(
            eq(workstreams.workspaceId, scope.workspaceId),
            inArray(workstreams.scopeKey, [...fromKeys]),
            isNotNull(workstreams.content)
          )
        )
        .orderBy(desc(workstreams.updatedAt), workstreams.id),
      transaction
        .select()
        .from(workstreams)
        .where(
          and(
            eq(workstreams.workspaceId, scope.workspaceId),
            eq(workstreams.scopeKey, toKey)
          )
        ),
    ]);
    const taken = new Set(targets.map(({ id }) => id));
    const held = new Set(
      targets.flatMap(({ content }) =>
        content ? [JSON.stringify(content)] : []
      )
    );
    let room =
      maximumWorkstreams - targets.filter(({ content }) => content).length;
    const now = new Date();
    let moved = 0;
    for (const row of sources) {
      if (!row.content) continue;
      const same = held.has(JSON.stringify(row.content));
      if (!same && room <= 0) continue;
      if (!same) {
        const id = freeWorkstreamId(row.id, taken);
        // oxlint-disable-next-line eslint/no-await-in-loop -- One transaction: its statements run one after another anyway.
        await transaction.insert(workstreams).values({
          content: row.content,
          id,
          lastOperationId: `adopt:${row.scopeKey}:${row.id}`,
          revision: 1,
          scopeKey: toKey,
          sessionId: row.sessionId,
          updatedAt: row.updatedAt,
          workspaceId: scope.workspaceId,
        });
        taken.add(id);
        held.add(JSON.stringify(row.content));
        room -= 1;
        moved += 1;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Same transaction as the insert above.
      await transaction
        .update(workstreams)
        .set({
          content: null,
          lastOperationId: `adopted:${toKey}`,
          revision: row.revision + 1,
          sessionId: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(workstreams.workspaceId, scope.workspaceId),
            eq(workstreams.scopeKey, row.scopeKey),
            eq(workstreams.id, row.id),
            eq(workstreams.revision, row.revision)
          )
        );
    }
    return moved;
  });
}

/** `id`, or the first `id-2`, `id-3`… that is free and still a valid ID. */
function freeWorkstreamId(id: string, taken: ReadonlySet<string>) {
  if (!taken.has(id)) return id;
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${String(suffix)}`;
    const candidate = `${id.slice(0, 80 - tail.length).replace(/-+$/u, "")}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
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
