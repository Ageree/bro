import { z } from "zod";
import { browserHostReserveMb } from "@agent/lib/browser-pool/host";
import { browserVmLlmService } from "@agent/lib/browser-vm/backend";
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
  /**
   * What the model's service billed for every call of the run, in its own
   * currency (`Billed` in browser-vm/worker/worker.py): the calls whose
   * answer browser-use could not parse too. Absent from a worker older than
   * 2026-10-01.1.
   */
  billed: z.number().nonnegative().nullish(),
  /**
   * How many of the run's answers each upstream host served, by the name
   * the service gives it (`Billed.hosts`). Absent from a worker older than
   * 2026-10-03.1; a malformed one is dropped, not the run's cost.
   */
  hosts: z
    .record(z.string().min(1).max(64), z.number().int().nonnegative())
    .optional()
    .catch(undefined),
  total_completion_tokens: z.number().nonnegative().nullish(),
  total_cost: z.number().nonnegative().nullish(),
  total_prompt_cached_tokens: z.number().nonnegative().nullish(),
  total_prompt_tokens: z.number().nonnegative().nullish(),
});

/**
 * A settled VM run's model and proxy traffic, keyed by the run id so every
 * read of the settled run after the first changes nothing. RouterAI's own
 * bill for the run's calls is the cost when the worker reports it: the
 * token count misses the calls browser-use could not parse, and RouterAI's
 * price changed twofold within one morning (01.10). Otherwise the tokens are
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
    const billedRub =
      browserVmLlmService() === "routerai"
        ? (usage.billed ?? undefined)
        : undefined;
    const priced = billedRub ?? routerAiTokensRub(model, tokens);
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
        ...(usage.hosts === undefined ? {} : { hosts: usage.hosts }),
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
  return recordUptime(workspaceId, poweredOnAt, until, {
    flavor: env.CLOUDRU_BROWSER_FLAVOR,
    key: "browser-vm",
  });
}

/**
 * One stretch a workspace's sandbox of the browser pool lived on a host,
 * from `startedAt` to `until`, recorded when it leaves the host (parked,
 * lost with the host, deleted). The host bills by the hour whoever it
 * holds, so the stretch is charged at the host's hourly price times the
 * sandbox's share of it: its memory limit over the memory the host gives
 * its sandboxes (the flavor's less `hostd`'s 1 GB reserve), which is what
 * placement fills hosts by. The time a host stands empty before it is
 * deleted is nobody's errand and is not charged to a workspace. Shared
 * between the errands of the stretch like a VM's time, under a key of its
 * own. True when it is on record.
 */
export async function recordBrowserSandboxUptime(
  workspaceId: string,
  startedAt: Date,
  until: Date
) {
  const flavor = env.BROWSER_HOST_FLAVOR;
  const flavorMb = Number(/-(?<gb>\d+)$/u.exec(flavor)?.groups?.gb) * 1024;
  const sandboxesMb = flavorMb - browserHostReserveMb;
  const share =
    Number.isFinite(sandboxesMb) && sandboxesMb > 0
      ? Math.min(env.BROWSER_SANDBOX_MEMORY_MB / sandboxesMb, 1)
      : 1;
  return recordUptime(workspaceId, startedAt, until, {
    flavor,
    key: "browser-sandbox",
    share,
  });
}

async function recordUptime(
  workspaceId: string,
  poweredOnAt: Date,
  until: Date,
  rate: {
    readonly flavor: string;
    readonly key: string;
    readonly share?: number;
  }
) {
  const seconds = Math.max(
    0,
    Math.round((until.getTime() - poweredOnAt.getTime()) / 1000)
  );
  // A create refused outright never had a VM on.
  if (seconds === 0) return true;
  const { flavor } = rate;
  const hourly = vmUptimeRub(flavor, seconds);
  if (hourly === undefined) {
    console.warn("[usage-costs] no hourly price for the VM flavor", {
      flavor,
    });
  }
  const costRub =
    hourly === undefined || rate.share === undefined
      ? hourly
      : hourly * rate.share;
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
  const key = `${rate.key}:${workspaceId}:${poweredOnAt.toISOString()}`;
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
          // Absent from a VM's own stretch (undefined is not written).
          hostShare: rate.share,
        },
        workspaceId,
      })
    )
  );
  return recorded.every(Boolean);
}
