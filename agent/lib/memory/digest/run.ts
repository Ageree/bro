import { z } from "zod";
import { planDedupe } from "@agent/lib/memory/digest/dedupe";
import { memoryDigestPilot } from "@agent/lib/memory/digest/pilot";
import { redactUnsafeText } from "@agent/lib/memory/digest/redact";
import {
  claimMemoryDigestDay,
  finishMemoryDigestDay,
  listMemoryDigestWorkspaces,
} from "@db/services/memory/digest-runs";
import {
  forgetMemory,
  listCurrentMemories,
  listMemoryScopeKeys,
  updateMemory,
} from "@db/services/memory/records";
import {
  trimMemoryHistory,
  wipeUnsafeMemoryHistory,
} from "@db/services/memory/revisions";
import { readWorkspaceScope } from "@db/services/scope";
import {
  listWorkspaceWorkstreams,
  saveWorkstream,
} from "@db/services/workstreams";
import { localDayKey, localHour } from "@shared/calendar/local-period";
import type { AccessScope } from "@shared/identity/access-scope";
import { isSafeMemoryText } from "@shared/memory/schema";
import { resolveTimeZone } from "@shared/user-profile/schema";

/** The local hour from which a day's digest may run: the night is over. */
const digestFromHour = 4;
const workspacesPerTick = 25;
const leaseMs = 15 * 60_000;
const dayMs = 24 * 60 * 60_000;

const digest = { actor: "digest" } as const;

type Outcome = Record<
  | "contained"
  | "deduped"
  | "historyTrimmed"
  | "historyWiped"
  | "purged"
  | "redacted"
  | "skipped"
  | "workstreamsRedacted",
  number
>;

/**
 * Runs the daily memory digest for each workspace whose local day has come
 * and has no digest yet, a few per tick. No model and no turn: the digest
 * cuts one-time codes and credentials out of memory and its history, folds
 * duplicate memories together for the pilot (MEMORY_DIGEST_WORKSPACES) and
 * trims the history. A workspace that fails is retried at the next tick.
 */
export async function runDueMemoryDigests(now = new Date()) {
  const tickStartedAt = Date.now();
  const workspaces = await listMemoryDigestWorkspaces(
    localDayKey(new Date(now.getTime() - 2 * dayMs), "UTC")
  );
  const due = workspaces.flatMap(({ doneDates, timeZone, workspaceId }) => {
    const zone = resolveTimeZone(timeZone);
    const localDate = localDayKey(now, zone);
    return localHour(now, zone) >= digestFromHour &&
      !doneDates.includes(localDate)
      ? [{ localDate, workspaceId }]
      : [];
  });
  let started = 0;
  for (const { localDate, workspaceId } of due) {
    if (started >= workspacesPerTick) break;
    // Each claim's lease runs from when it is taken, not from the tick's
    // start: the workspaces before it may have taken minutes.
    const claimedAt = new Date(now.getTime() + Date.now() - tickStartedAt);
    if (
      // oxlint-disable-next-line eslint/no-await-in-loop -- One workspace at a time: each write locks its memory scope.
      !(await claimMemoryDigestDay(workspaceId, localDate, leaseMs, claimedAt))
    )
      continue;
    started += 1;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      const outcome = await digestWorkspace(workspaceId, localDate);
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      await finishMemoryDigestDay(workspaceId, localDate, claimedAt, {
        outcome,
      });
      console.info("[memory-digest] run", { outcome, workspaceId });
    } catch (error) {
      const errorCode = error instanceof Error ? error.name : "unknown";
      console.warn("[memory-digest] run failed", { errorCode, workspaceId });
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      await finishMemoryDigestDay(workspaceId, localDate, claimedAt, {
        errorCode,
      });
    }
  }
  if (started >= workspacesPerTick) {
    console.info("[memory-digest] some workspaces wait for the next tick", {
      due: due.length,
      started,
    });
  }
}

/** One workspace's digest; returns what it did, in counts. */
export async function digestWorkspace(workspaceId: string, localDate: string) {
  const outcome: Outcome = {
    contained: 0,
    deduped: 0,
    historyTrimmed: 0,
    historyWiped: 0,
    purged: 0,
    redacted: 0,
    skipped: 0,
    workstreamsRedacted: 0,
  };
  const scope = await readWorkspaceScope(workspaceId);
  if (scope === null) return outcome;
  const merges = await memoryDigestPilot(scope);
  for (const scopeKey of await listMemoryScopeKeys(workspaceId)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Scopes one at a time: each write locks the workspace.
    await digestScope(scope, scopeKey, `memory-digest:${localDate}`, {
      merges,
      outcome,
    });
  }
  await redactWorkstreams(scope, `memory-digest:${localDate}`, outcome);
  outcome.historyWiped = await wipeUnsafeMemoryHistory(workspaceId);
  outcome.historyTrimmed = await trimMemoryHistory(workspaceId);
  return outcome;
}

async function digestScope(
  scope: AccessScope,
  scopeKey: string,
  operation: string,
  { merges, outcome }: { readonly merges: boolean; readonly outcome: Outcome }
) {
  const records = (await listCurrentMemories(scope, scopeKey)).flatMap(
    ({ content, index, revision }) =>
      content ? [{ content, index, revision }] : []
  );
  const purged = new Set<number>();
  for (const record of records) {
    const { aliases, category, text } = record.content;
    if ([text, ...aliases].every(isSafeMemoryText)) continue;
    purged.add(record.index);
    const identity = `${operation}:purge:${String(record.index)}:${String(record.revision)}`;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each write locks the memory scope.
    const done = await skipChanged<object>(() =>
      // A rule keeps binding Bro with the code cut out of it; any other
      // memory with a code in it goes.
      category === "rule"
        ? updateMemory(
            scope,
            scopeKey,
            {
              content: {
                ...record.content,
                aliases: aliases.filter(isSafeMemoryText),
                text: redactUnsafeText(text),
              },
              expectedRevision: record.revision,
              index: record.index,
            },
            identity,
            { ...digest, action: "purge" }
          )
        : forgetMemory(
            scope,
            scopeKey,
            { expectedRevision: record.revision, index: record.index },
            identity,
            { ...digest, action: "purge" }
          )
    );
    if (!done) outcome.skipped += 1;
    else if (category === "rule") outcome.redacted += 1;
    else outcome.purged += 1;
  }
  if (!merges) return;
  const plan = planDedupe(records.filter(({ index }) => !purged.has(index)));
  // The revision each record is at after this digest's own writes.
  const revisions = new Map(
    records.map(({ index, revision }) => [index, revision])
  );
  for (const { aliases, record } of plan.keep) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    const done = await skipChanged(() =>
      updateMemory(
        scope,
        scopeKey,
        {
          content: { ...record.content, aliases: [...aliases] },
          expectedRevision: record.revision,
          index: record.index,
        },
        `${operation}:aliases:${String(record.index)}:${String(record.revision)}`,
        { ...digest, action: "merge" }
      )
    );
    if (done) revisions.set(record.index, record.revision + 1);
    else outcome.skipped += 1;
  }
  for (const { into, reason, record } of plan.drop) {
    // What it folds into must still say what the plan read, checked in the
    // forget's own transaction: a record the conversation reworded meanwhile
    // may no longer hold this one's words.
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    const done = await skipChanged(() =>
      forgetMemory(
        scope,
        scopeKey,
        {
          expectedRevision: record.revision,
          index: record.index,
          keeper: { index: into, revision: revisions.get(into) ?? 0 },
        },
        `${operation}:merge:${String(record.index)}:${String(record.revision)}`,
        { ...digest, action: "merge" }
      )
    );
    if (!done) outcome.skipped += 1;
    else if (reason === "duplicate") outcome.deduped += 1;
    else outcome.contained += 1;
  }
}

/** Cuts credentials and one-time codes out of the workspace's workstreams. */
async function redactWorkstreams(
  scope: AccessScope,
  operation: string,
  outcome: Outcome
) {
  for (const workstream of await listWorkspaceWorkstreams(scope.workspaceId)) {
    const { content } = workstream;
    const redacted = {
      ...content,
      nextStep: redactUnsafeText(content.nextStep),
      notes: redactUnsafeText(content.notes),
      objective: redactUnsafeText(content.objective),
      sources: content.sources.map((source) => ({
        ...source,
        observation: redactUnsafeText(source.observation),
        reference: redactUnsafeText(source.reference),
      })),
      title: redactUnsafeText(content.title),
    };
    if (JSON.stringify(redacted) === JSON.stringify(content)) continue;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each save locks the workspace.
    const done = await skipChanged(() =>
      saveWorkstream(
        scope,
        workstream.scopeKey,
        {
          content: redacted,
          expectedRevision: workstream.revision,
          id: workstream.id,
        },
        `${operation}:workstream:${workstream.id}:${String(workstream.revision)}`,
        workstream.sessionId ?? operation
      )
    );
    if (done) outcome.workstreamsRedacted += 1;
    else outcome.skipped += 1;
  }
}

/** Postgres's answer to a transaction it chose to end in a deadlock. */
const deadlock = z.object({ code: z.literal("40P01") });

/**
 * Runs a write the conversation may have raced: a memory changed since the
 * digest read it is left for tomorrow rather than failing the day.
 */
async function skipChanged<Result>(write: () => Promise<Result>) {
  try {
    await write();
    return true;
  } catch (error) {
    // A text the cut made too long for its field is left as well, and so is
    // a write that lost a deadlock to expiry.
    if (
      error instanceof Error &&
      (error.name === "ZodError" ||
        /changed|forgotten/u.test(error.message) ||
        deadlock.safeParse(error.cause).success)
    )
      return false;
    throw error;
  }
}
