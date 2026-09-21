import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, memoryRecords, memoryScopes, memorySync } from "@db";
import type { AccessScope } from "@shared/identity/access-scope";

const leaseMs = 60_000;

export async function claimMemorySyncJobs(limit = 20, now = new Date()) {
  return db.transaction(async (transaction) => {
    const jobs = await transaction
      .select()
      .from(memorySync)
      .where(
        or(
          and(
            inArray(memorySync.status, ["pending", "failed"]),
            sql`${memorySync.nextAttemptAt} <= ${now}`,
            or(isNull(memorySync.leaseUntil), lt(memorySync.leaseUntil, now))
          ),
          and(
            eq(memorySync.status, "processing"),
            lt(memorySync.leaseUntil, now)
          )
        )
      )
      .orderBy(asc(memorySync.desiredPresent), memorySync.nextAttemptAt)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (jobs.length === 0) return [];
    const leaseUntil = new Date(now.getTime() + leaseMs);
    await Promise.all(
      jobs.map((job) =>
        transaction
          .update(memorySync)
          .set({ leaseUntil, status: "processing", updatedAt: now })
          .where(jobIdentity(job))
      )
    );
    return jobs.map((job) => Object.assign({}, job, { leaseUntil }));
  });
}

export async function readMemorySyncSource(
  job: Awaited<ReturnType<typeof claimMemorySyncJobs>>[number]
) {
  const [[record], [scope]] = await Promise.all([
    db
      .select()
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.workspaceId, job.workspaceId),
          eq(memoryRecords.scopeKey, job.scopeKey),
          eq(memoryRecords.index, job.recordIndex)
        )
      )
      .limit(1),
    db
      .select()
      .from(memoryScopes)
      .where(
        and(
          eq(memoryScopes.workspaceId, job.workspaceId),
          eq(memoryScopes.scopeKey, job.scopeKey)
        )
      )
      .limit(1),
  ]);
  return { record: record ?? null, scope: scope ?? null };
}

export async function completeMemorySyncJob(
  job: Awaited<ReturnType<typeof claimMemorySyncJobs>>[number],
  providerDocumentId: string | null
) {
  const completed = await db
    .update(memorySync)
    .set({
      lastErrorCode: null,
      leaseUntil: null,
      providerDocumentId: providerDocumentId ?? job.providerDocumentId ?? null,
      status: "completed",
      updatedAt: new Date(),
    })
    .where(claimIdentity(job))
    .returning({ recordIndex: memorySync.recordIndex });
  return completed.length === 1;
}

export async function failMemorySyncJob(
  job: Awaited<ReturnType<typeof claimMemorySyncJobs>>[number],
  errorCode: string
) {
  const attempts = job.attempts + 1;
  const delayMs = Math.min(60 * 60_000, 2 ** Math.min(attempts, 10) * 5_000);
  const failed = await db
    .update(memorySync)
    .set({
      attempts,
      lastErrorCode: errorCode.slice(0, 80),
      leaseUntil: null,
      nextAttemptAt: new Date(Date.now() + delayMs),
      status: "failed",
      updatedAt: new Date(),
    })
    .where(claimIdentity(job))
    .returning({ recordIndex: memorySync.recordIndex });
  return failed.length === 1;
}

export async function hydrateIndexedMemory(
  scope: AccessScope,
  scopeKey: string,
  metadata: {
    generation: number;
    recordIndex: number;
    revision: number;
  }
) {
  const [row] = await db
    .select()
    .from(memoryRecords)
    .where(
      and(
        eq(memoryRecords.workspaceId, scope.workspaceId),
        eq(memoryRecords.scopeKey, scopeKey),
        eq(memoryRecords.index, metadata.recordIndex),
        eq(memoryRecords.revision, metadata.revision),
        eq(memoryRecords.generation, metadata.generation),
        sql`${memoryRecords.content} IS NOT NULL`,
        or(
          sql`${memoryRecords.content}->>'validUntil' IS NULL`,
          sql`(${memoryRecords.content}->>'validUntil')::timestamptz > now()`
        )
      )
    )
    .limit(1);
  return row?.content
    ? {
        content: row.content,
        index: row.index,
        revision: row.revision,
        updatedAt: row.updatedAt.toISOString(),
      }
    : null;
}

function jobIdentity(job: {
  workspaceId: string;
  scopeKey: string;
  recordIndex: number;
  revision: number;
}) {
  return and(
    eq(memorySync.workspaceId, job.workspaceId),
    eq(memorySync.scopeKey, job.scopeKey),
    eq(memorySync.recordIndex, job.recordIndex),
    eq(memorySync.revision, job.revision)
  );
}

function claimIdentity(
  job: Awaited<ReturnType<typeof claimMemorySyncJobs>>[number]
) {
  return and(
    jobIdentity(job),
    eq(memorySync.status, "processing"),
    eq(memorySync.leaseUntil, job.leaseUntil)
  );
}
