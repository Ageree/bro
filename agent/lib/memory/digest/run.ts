import { z } from "zod";
import {
  classifierCandidates,
  classifyMemories,
} from "@agent/lib/memory/digest/classifier";
import { mergedAliases, planDedupe } from "@agent/lib/memory/digest/dedupe";
import {
  memoryDigestConfigured,
  memoryDigestPilot,
  memoryDigestPilotEntries,
} from "@agent/lib/memory/digest/pilot";
import {
  redactionPlaceholder,
  redactUnsafeText,
} from "@agent/lib/memory/digest/redact";
import {
  claimMemoryDigestDay,
  finishMemoryDigestDay,
  lastMemoryClassificationStartedAt,
  markMemoryClassifierAsked,
  memoryClassifierAskedOn,
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
import { directModelActive } from "@shared/model/provider";
import { resolveTimeZone } from "@shared/user-profile/schema";

/** The local hour from which a day's digest may run: the night is over. */
const digestFromHour = 4;
const workspacesPerTick = 25;
const leaseMs = 15 * 60_000;
const dayMs = 24 * 60 * 60_000;

const digest = { actor: "digest" } as const;

type Outcome = Record<
  | "classified"
  | "classifierCalls"
  | "classifierFailed"
  | "contained"
  | "corrected"
  | "deduped"
  | "historyTrimmed"
  | "historyWiped"
  | "oneOff"
  | "purged"
  | "redacted"
  | "skipped"
  | "workstreamsRedacted",
  number
>;

/**
 * Runs the daily memory digest for each pilot workspace
 * (MEMORY_DIGEST_WORKSPACES) whose local day has come and has no digest yet,
 * a few per tick. No model and no turn: the digest cuts one-time codes and
 * credentials out of memory, its history and workstreams, folds duplicate
 * memories together and trims the history. Everything it does changes what
 * a person has saved, so nothing runs outside the pilot. A workspace that
 * fails is retried at the next tick.
 */
export async function runDueMemoryDigests(now = new Date()) {
  if (!memoryDigestConfigured()) return;
  const tickStartedAt = Date.now();
  const workspaces = await listMemoryDigestWorkspaces(
    localDayKey(new Date(now.getTime() - 2 * dayMs), "UTC"),
    memoryDigestPilotEntries()
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
    classified: 0,
    classifierCalls: 0,
    classifierFailed: 0,
    contained: 0,
    corrected: 0,
    deduped: 0,
    historyTrimmed: 0,
    historyWiped: 0,
    oneOff: 0,
    purged: 0,
    redacted: 0,
    skipped: 0,
    workstreamsRedacted: 0,
  };
  const scope = await readWorkspaceScope(workspaceId);
  if (scope === null || !(await memoryDigestPilot(scope))) return outcome;
  // The model looks again only at memory that changed since the last digest
  // that asked it — counted from that digest's start, so a memory saved while
  // it ran is asked about the next day.
  const since = await lastMemoryClassificationStartedAt(workspaceId);
  // A day taken again after a failure does not pay for the model twice.
  const classify =
    directModelActive() &&
    !(await memoryClassifierAskedOn(workspaceId, localDate));
  for (const scopeKey of await listMemoryScopeKeys(workspaceId)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Scopes one at a time: each write locks the workspace.
    await digestScope(scope, scopeKey, `memory-digest:${localDate}`, outcome);
    if (classify) {
      outcome.classified += 1;
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      await classifyScope(scope, scopeKey, { localDate, outcome, since });
    }
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
  outcome: Outcome
) {
  const records = (await listCurrentMemories(scope, scopeKey)).flatMap(
    ({ content, index, revision }) =>
      content ? [{ content, index, revision }] : []
  );
  const purged = new Set<number>();
  for (const record of records) {
    const { aliases, text } = record.content;
    if ([text, ...aliases].every(isSafeMemoryText)) continue;
    purged.add(record.index);
    const identity = `${operation}:purge:${String(record.index)}:${String(record.revision)}`;
    const redacted = redactUnsafeText(text);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each write locks the memory scope.
    const done = await skipChanged<object>(() =>
      // The memory keeps what it says with the code cut out of it; one that
      // said nothing but the code goes.
      saysMoreThanCode(redacted)
        ? updateMemory(
            scope,
            scopeKey,
            {
              content: {
                ...record.content,
                aliases: aliases.filter(isSafeMemoryText),
                text: redacted,
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
    else if (saysMoreThanCode(redacted)) outcome.redacted += 1;
    else outcome.purged += 1;
  }
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

/** A memory at the revision a digest write expects. */
interface Revisioned {
  readonly index: number;
  readonly revision: number;
}

/**
 * The model's part of the digest, for the pilot: one-off task details,
 * duplicates in other words and facts a newer one corrects, as
 * `classifyMemories` checked them. A failed call changes nothing; the code
 * steps of the day stand.
 */
async function classifyScope(
  scope: AccessScope,
  scopeKey: string,
  {
    localDate,
    outcome,
    since,
  }: {
    readonly localDate: string;
    readonly outcome: Outcome;
    readonly since: Date | null;
  }
) {
  const candidates = classifierCandidates(
    (await listCurrentMemories(scope, scopeKey)).flatMap(
      ({ content, index, revision, updatedAt }) =>
        content ? [{ content, index, revision, updatedAt }] : []
    )
  );
  const changed = candidates.some(
    ({ updatedAt }) => since === null || new Date(updatedAt) > since
  );
  // One memory alone may still be a one-off task detail.
  if (candidates.length === 0 || !changed) return;
  let plan: Awaited<ReturnType<typeof classifyMemories>>;
  try {
    outcome.classifierCalls += 1;
    await markMemoryClassifierAsked(scope.workspaceId, localDate);
    plan = await classifyMemories(candidates, {
      localDate,
      scopeKey,
      workspaceId: scope.workspaceId,
    });
  } catch (error) {
    // The day is done but not this step: the next digest asks again.
    outcome.classifierFailed += 1;
    console.warn("[memory-digest] classifier failed", {
      errorCode: error instanceof Error ? error.name : "unknown",
      workspaceId: scope.workspaceId,
    });
    return;
  }
  const operation = `memory-digest:${localDate}`;
  const forget = (
    record: Revisioned,
    action: "correct" | "merge" | "one_off",
    keeper?: Revisioned
  ) =>
    skipChanged(() =>
      forgetMemory(
        scope,
        scopeKey,
        { expectedRevision: record.revision, index: record.index, keeper },
        `${operation}:${action}:${String(record.index)}:${String(record.revision)}`,
        { ...digest, action }
      )
    );
  const rewrite = (
    record: (typeof candidates)[number],
    content: (typeof candidates)[number]["content"],
    action: "correct" | "merge"
  ) =>
    skipChanged(() =>
      updateMemory(
        scope,
        scopeKey,
        { content, expectedRevision: record.revision, index: record.index },
        `${operation}:${action}:${String(record.index)}:${String(record.revision)}`,
        { ...digest, action }
      )
    );
  for (const { newer, older, text } of plan.corrections) {
    // The newer fact is rewritten first, the older forgotten only while the
    // rewrite still stands: a conversation that changed either meanwhile
    // leaves both, and nothing is lost.
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each write locks the memory scope.
    const rewritten = await rewrite(
      newer,
      { ...newer.content, aliases: mergedAliases(newer, [older]), text },
      "correct"
    );
    if (!rewritten) {
      outcome.skipped += 1;
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    const forgotten = await forget(older, "correct", {
      index: newer.index,
      revision: newer.revision + 1,
    });
    if (forgotten) outcome.corrected += 1;
    else outcome.skipped += 1;
  }
  for (const { into, record } of plan.duplicates) {
    const aliases = mergedAliases(into, [record]);
    let keeper: Revisioned = into;
    if (aliases.length > into.content.aliases.length) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
      const kept = await rewrite(into, { ...into.content, aliases }, "merge");
      if (!kept) {
        outcome.skipped += 1;
        continue;
      }
      keeper = { index: into.index, revision: into.revision + 1 };
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    if (await forget(record, "merge", keeper)) outcome.deduped += 1;
    else outcome.skipped += 1;
  }
  for (const record of plan.oneOff) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    if (await forget(record, "one_off")) outcome.oneOff += 1;
    else outcome.skipped += 1;
  }
}

/** Whether a text with its codes cut out still says something. */
function saysMoreThanCode(text: string) {
  return /[\p{L}\p{N}]/u.test(text.replaceAll(redactionPlaceholder, ""));
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
