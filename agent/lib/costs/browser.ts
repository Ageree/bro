import { z } from "zod";
import type { readBrowserVmWorkerRun } from "@agent/lib/browser-vm/worker";
import {
  proxyTrafficRub,
  routerAiTokensRub,
  usdToRub,
  vmUptimeRub,
} from "@shared/costs/prices";
import { listBrowserVmRunIdsBetween } from "@db/services/browser-vms";
import { env } from "@shared/environment";
import { recordCost } from "./record";

type WorkerRun = NonNullable<
  Awaited<ReturnType<typeof readBrowserVmWorkerRun>>
>;

/** What browser-use reports of a run's model calls (`usage_summary`). */
const workerUsageSchema = z.object({
  total_completion_tokens: z.number().nonnegative().nullish(),
  total_cost: z.number().nonnegative().nullish(),
  total_prompt_cached_tokens: z.number().nonnegative().nullish(),
  total_prompt_tokens: z.number().nonnegative().nullish(),
});

/**
 * A settled VM run's model and proxy traffic, keyed by the run id so every
 * read of the settled run after the first changes nothing. The tokens are
 * priced at RouterAI's roubles; a model without a price there falls back to
 * browser-use's own `total_cost`, which comes from its dollar price list.
 */
export async function recordBrowserVmRunCosts(
  workspaceId: string,
  run: WorkerRun,
  now: Date
) {
  const occurredAt = run.finishedAt === null ? now : new Date(run.finishedAt);
  const at = Number.isNaN(occurredAt.getTime()) ? now : occurredAt;
  const usage =
    run.usage === null
      ? undefined
      : workerUsageSchema.safeParse(run.usage).data;
  if (usage !== undefined) {
    const tokens = {
      cachedInputTokens: usage.total_prompt_cached_tokens ?? 0,
      inputTokens: usage.total_prompt_tokens ?? 0,
      outputTokens: usage.total_completion_tokens ?? 0,
    };
    const model = env.BROWSER_VM_MODEL;
    const priced = routerAiTokensRub(model, tokens);
    const reportedUsd = usage.total_cost ?? undefined;
    const unpriced =
      priced === undefined && (reportedUsd === undefined || reportedUsd === 0);
    if (unpriced) {
      // Zero roubles here means "no price", not "free": the owner adds the
      // model to the RouterAI price table.
      console.warn("[usage-costs] no price for the VM model", { model });
    }
    await recordCost({
      costRub:
        priced ?? (reportedUsd === undefined ? 0 : usdToRub(reportedUsd)),
      costUsd: priced === undefined ? (reportedUsd ?? null) : null,
      idempotencyKey: `browser-run:${run.id}`,
      occurredAt: at,
      runId: run.id,
      sessionId: run.sessionId,
      source: "browser-run",
      units: {
        ...tokens,
        model,
        steps: run.stepCount,
        unpriced,
      },
      workspaceId,
    });
  }
  const traffic = run.traffic;
  if (traffic !== null && traffic !== undefined) {
    const bytes = traffic.up + traffic.down;
    await recordCost({
      costRub: proxyTrafficRub(bytes),
      costUsd: null,
      idempotencyKey: `proxy:${run.id}`,
      occurredAt: at,
      runId: run.id,
      sessionId: run.sessionId,
      source: "proxy",
      units: { bytes },
      workspaceId,
    });
  }
}

/** A settled Browser Use Cloud run's model, as it priced it in dollars. */
export async function recordBrowserUseRunCost(input: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly costUsd: number;
  readonly now: Date;
}) {
  await recordCost({
    costRub: usdToRub(input.costUsd),
    costUsd: input.costUsd,
    idempotencyKey: `browser-run:${input.runId}`,
    occurredAt: input.now,
    runId: input.runId,
    sessionId: input.sessionId,
    source: "browser-run",
    units: {},
    workspaceId: input.workspaceId,
  });
}

/**
 * One stretch a workspace VM was powered on, from `poweredOnAt` to `until`,
 * recorded when it is written down as off or removed. It is shared equally
 * between the errands whose runs were going during it, so an errand's cost
 * carries the VM that served it; a stretch no run touched (a profile wipe,
 * say) stays the workspace's alone. The start of the stretch is the key: the
 * same stretch written again changes nothing. True when it is on record, so
 * the caller keeps the start until it is.
 */
export async function recordBrowserVmUptime(
  workspaceId: string,
  poweredOnAt: Date,
  until: Date
) {
  const seconds = Math.max(
    0,
    Math.round((until.getTime() - poweredOnAt.getTime()) / 1000)
  );
  // A create refused outright never had a VM on.
  if (seconds === 0) return true;
  const flavor = env.CLOUDRU_BROWSER_FLAVOR;
  const costRub = vmUptimeRub(flavor, seconds);
  if (costRub === undefined) {
    console.warn("[usage-costs] no hourly price for the VM flavor", {
      flavor,
    });
  }
  let runIds: string[];
  try {
    runIds = await listBrowserVmRunIdsBetween(workspaceId, poweredOnAt, until);
  } catch (error) {
    console.warn("[usage-costs] the VM's errands could not be read", {
      error: error instanceof Error ? error.message : String(error),
      workspaceId,
    });
    return false;
  }
  const key = `browser-vm:${workspaceId}:${poweredOnAt.toISOString()}`;
  const shares = runIds.length === 0 ? [null] : runIds;
  const recorded = await Promise.all(
    shares.map(async (runId) =>
      recordCost({
        costRub: (costRub ?? 0) / shares.length,
        costUsd: null,
        idempotencyKey: runId === null ? key : `${key}:${runId}`,
        occurredAt: until,
        runId,
        sessionId: null,
        source: "browser-vm",
        units: {
          flavor,
          seconds: seconds / shares.length,
          sharedBy: shares.length,
        },
        workspaceId,
      })
    )
  );
  return recorded.every(Boolean);
}
