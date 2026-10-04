import { BrowserUseError } from "@agent/lib/browser-use/errors";
import type { browserVmRuns, browserVms } from "@db/schema/browser-vms";
import {
  findBrowserVmRunByTaskLine as findBrowserVmRunRecordByTaskLine,
  readBrowserVm,
  readBrowserVmRun as readBrowserVmRunRecord,
  recordBrowserVmRun,
  updateBrowserVm,
  updateBrowserVmRun,
} from "@db/services/browser-vms";
import { recordBrowserVmRunCosts } from "@agent/lib/costs/browser";
import { providerRouting } from "@agent/lib/model/direct";
import { alertOwner } from "@agent/lib/owner-alert";
import { env } from "@shared/environment";
import { browserVmCaptcha, browserVmLlm, browserVmLlmService } from "./backend";
import {
  browserVmBrowserId,
  browserVmProfileId,
  browserVmTargetOf,
  browserVmWorkspace,
  isBrowserVmId,
  newBrowserVmRunId,
  newBrowserVmSessionId,
} from "./ids";
import {
  ensureBrowserVm,
  prepareBrowserVmSession,
  touchBrowserVm,
} from "./lifecycle";
import {
  BrowserVmWorkerError,
  browserVmCdpUrl,
  browserVmFileUrl,
  cancelBrowserVmWorkerRun,
  closeBrowserVmWorkerTab,
  listBrowserVmWorkerFiles,
  openBrowserVmWorkerTab,
  readBrowserVmWorkerRun,
  readBrowserVmWorkerSession,
  releaseBrowserVmWorkerSession,
  resetBrowserVmWorkerProfile,
  sendBrowserVmWorkerMessage,
  startBrowserVmWorkerRun,
} from "./worker";

/**
 * The browser VM side of every `agent/lib/browser-use/client.ts` call, which
 * sends here every id that starts with `vm:`. Each answers in the shape the
 * Browser Use call does, and the client parses it with the same schemas, so
 * the queue, the retries, the reports and the tool work on a VM errand
 * unchanged. Refusals come as `BrowserUseError` with the status Browser Use
 * would have used.
 *
 * While the VM is up its worker is the truth about a run; `browser_vm_runs`
 * answers when it is off, and keeps the composed task the worker is given.
 */

type BrowserVm = typeof browserVms.$inferSelect;
type BrowserVmRunRecord = typeof browserVmRuns.$inferSelect;
type WorkerRun = NonNullable<
  Awaited<ReturnType<typeof readBrowserVmWorkerRun>>
>;

/** The steps and the time a run is given, about Browser Use's own budget. */
const runMaxSteps = 60;
const runTimeoutSeconds = 1_500;
/**
 * RouterAI's hosts of `deepseek/deepseek-v4.1-flash` without
 * `structured_outputs` (its `/models/…/endpoints`, 03.10). browser-use asks
 * every step for a strict JSON schema; left to pick a host itself, RouterAI
 * served six errands of 03.10 from them, and their answers failed
 * `AgentOutput` («action Field required», invalid JSON) until browser-use
 * ended the run after four in a row. RouterAI takes `require_parameters`
 * without filtering on it (it served the same call from `deepseek`), so the
 * hosts are named. Fourteen others with structured outputs stay behind the
 * pinned `deepinfra`.
 */
const routerAiHostsWithoutStructuredOutputs = [
  "deepseek",
  "relace",
  "streamlake",
  "gmicloud",
  "phala",
  "novita",
  "siliconflow",
  "alibaba",
];

/**
 * How the VM's browser-use agent runs (bench of 01.10, `docs/agent-costs.md`,
 * section 3.3): DeepSeek's hidden reasoning off — browser-use has the model
 * think in its answer anyway, and the hidden tokens were a third of the
 * errand's price and slowed every step — and up to eight actions in a step,
 * with the worker's hint to put the obvious ones together. Flash mode was
 * cheaper still on the bench, but drops browser-use's own rules and the
 * model's written reasoning: not before errands that sign in or stage a
 * checkout were measured with it.
 *
 * Its hosts are the main agent's (`providerRouting`: the pinned caching
 * host, the broken ones skipped) less those without structured outputs.
 * The main agent's ROUTERAI_PROVIDER_* do not apply: they tune another
 * model and service, and a pinned host there would lift its skip here.
 */
function runTuning(model: string) {
  const service = browserVmLlmService();
  const provider =
    service === undefined
      ? undefined
      : {
          ...providerRouting(model, {
            provider: service,
            providerIgnore:
              service === "routerai" && model.startsWith("deepseek/")
                ? routerAiHostsWithoutStructuredOutputs
                : [],
            providerOrder: undefined,
          }),
          requireParameters: true,
        };
  // GPT Luna on RouterAI answers with no `choices` at all when reasoning is
  // off and the parameters are required, so every step failed: it reasons
  // briefly instead (RU 04.10, a local browser-use run on a test form).
  const reasoning = model.startsWith("deepseek/") ? "none" : "low";
  return { maxActionsPerStep: 8, provider, reasoning } as const;
}
/** Another errand holds the VM's one browser: this one waits in the queue. */
const busyRetryMs = 60_000;
/**
 * A run recorded this recently that the worker does not know yet may still
 * be on its way to it: the start is recorded before it is sent.
 */
const dispatchGraceMs = 2 * 60_000;
/** Every read keeps the VM awake, but one write a minute is enough for that. */
const touchEveryMs = 60_000;
const stoppedBeforeFinishing =
  "The browser VM stopped before the run finished.";
const neverStarted = "The browser VM worker did not take the run.";

const settledStatuses = new Set<BrowserVmRunRecord["status"]>([
  "cancelled",
  "completed",
  "failed",
]);

/**
 * Whether the poller looks after the browser VMs: the Cloud.ru key reads
 * and powers them, and the signing key opens their workers. It asks less
 * than `browserVmConfigured`, which new errands need: with the image, the
 * proxy or the model key taken away no errand starts on a VM, but the VMs
 * already made still bill until they are stopped when idle.
 */
export function browserVmReconcileConfigured() {
  return (
    env.CLOUDRU_KEY_ID !== undefined &&
    env.CLOUDRU_KEY_SECRET !== undefined &&
    env.BROWSER_VM_SIGNING_KEY !== undefined
  );
}

/**
 * A site that blocked the exit (Avito's «Доступ ограничен: проблема с IP»)
 * opens a GeeTest slider behind its continue button. The agent cannot drag
 * one well, and left to press the button itself it gave up before the
 * puzzle drew, so the worker's `solve_captcha` does all of it: presses the
 * button, waits, places the piece (or hands it to 2Captcha). Any other
 * check, or a wall that stays, hands over to the anti-bot retry from another
 * address at once.
 */
const addressWallLine =
  "If the site blocks this network address (for example «Доступ ограничен: проблема с IP»), call the solve_captcha action once: it gets past the site's check itself. If the wall is still there after it, or the check is of another kind, stop right away and end with NEEDS: captcha: Bro retries from another address. Do not keep solving it.";

/**
 * Start a run on the workspace's VM, powering the VM on or creating it
 * first: until it is up the start answers 429 with the wait, and the errand
 * waits in the queue as it does for a busy Browser Use project.
 *
 * Only what the VM uses is read of the Browser Use run input
 * (`BrowserUseCreateRunInput`): the VM brings its own proxy and model, and
 * its budget is steps and time rather than money.
 */
export async function createBrowserVmRun(input: {
  /**
   * Ask for an exit address the workspace has not used before, when one is
   * available, rather than whatever the last check left: an anti-bot wall
   * has already judged the current one (anti-bot retries and follow-ups of
   * a walled errand). Absent, the exit is only kept alive or, for a new
   * session, rotated as `prepareBrowserVmSession` always does.
   */
  readonly freshExit?: boolean;
  readonly profileId: string;
  readonly secretBindings?: readonly {
    readonly alias: string;
    readonly allowedDomains: readonly string[];
    readonly source: { readonly value: string };
  }[];
  readonly sessionId?: string;
  readonly task: string;
}) {
  const workspaceId = browserVmWorkspace(input.profileId);
  // A session of Browser Use, or of another workspace, is not on this VM:
  // the caller starts the run in a session of its own instead, as it does
  // for a Browser Use session that is gone.
  if (
    input.sessionId !== undefined &&
    !(
      isBrowserVmId(input.sessionId) &&
      browserVmWorkspace(input.sessionId) === workspaceId
    )
  ) {
    throw new BrowserUseError(
      404,
      "browser-vm",
      "The session is not on this workspace's browser VM."
    );
  }
  const now = new Date();
  const started = await ensureBrowserVm(workspaceId, now);
  if (started.kind === "starting") {
    throw new BrowserUseError(
      429,
      "browser-vm",
      "The browser is starting.",
      started.retryAfterMs
    );
  }
  // A follow-up in the errand's own session keeps the exit its sign-ins were
  // made from; only a new errand may be moved to another. `freshExit` asks
  // for one the workspace has not used before, for an anti-bot retry or a
  // follow-up of a walled errand.
  const vm = await prepareBrowserVmSession(started.vm, now, {
    freshExit: input.freshExit,
    rotate: input.sessionId === undefined,
  });
  const id = newBrowserVmRunId(workspaceId);
  const sessionId = input.sessionId ?? newBrowserVmSessionId(workspaceId);
  const task = `${input.task}\n\n${addressWallLine}`;
  // Recorded before the worker is asked: a start whose answer is lost still
  // has a row to be found by, and the task outlives the VM. Until the
  // worker takes it the run is only being sent (`dispatching`), and a
  // lookup by its task line asks the worker before adopting it.
  await recordBrowserVmRun({
    id,
    sessionId,
    status: "dispatching",
    task,
    workspaceId,
  });
  const llm = browserVmLlm();
  const accepted = await startRun(vm, {
    captcha: browserVmCaptcha(),
    id,
    llm,
    maxSteps: runMaxSteps,
    secrets: input.secretBindings?.map((binding) => ({
      alias: binding.alias,
      allowedDomains: [...binding.allowedDomains],
      value: binding.source.value,
    })),
    sessionId,
    task,
    timeoutSeconds: runTimeoutSeconds,
    tuning: runTuning(llm.model),
  });
  // The worker has it: the record says what the worker says from here. The
  // run is acting already, so a write that fails does not fail the start:
  // the caller would lose the run it has to track, and the next read
  // mirrors the worker into the record anyway.
  await afterAccepted(id, async () => {
    await updateBrowserVmRun(
      id,
      {
        finishedAt: settledStatuses.has(accepted.status) ? now : null,
        status: accepted.status,
      },
      now
    );
  });
  return {
    id,
    model: llm.model,
    sessionId: accepted.sessionId,
    status: accepted.status,
  };
}

/**
 * The run as the worker has it, mirrored into its record; from the record
 * when the VM is not up or does not answer. A run left open on a VM that is
 * off, or one the worker lost, will never finish and reads as failed.
 */
export async function readBrowserVmRun(runId: string) {
  const now = new Date();
  const [record, vm] = await Promise.all([
    readBrowserVmRunRecord(runId),
    readBrowserVm(browserVmWorkspace(runId)),
  ]);
  const live = await askWorker(vm, runId);
  if (live.kind === "found") {
    await mirror(record, live.run, now);
    await keepAwake(live.vm, now);
    return fromWorker(live.run, record);
  }
  if (record === undefined) {
    throw new BrowserUseError(404, "browser-vm", "No such run.");
  }
  if (settledStatuses.has(record.status)) return fromRecord(record);
  // Nothing runs on a VM that is off, or that there never was (nor on a
  // sandbox of the pool that is on no host).
  const vmOff =
    ((vm?.vmId ?? null) === null && (vm?.hostId ?? null) === null) ||
    vm?.state === "stopped" ||
    vm?.state === "failed";
  const lost =
    live.kind === "missing" &&
    record.createdAt.getTime() < now.getTime() - dispatchGraceMs;
  if (!vmOff && !lost) return fromRecord(record);
  const failed = await updateBrowserVmRun(
    runId,
    { error: stoppedBeforeFinishing, finishedAt: now, status: "failed" },
    now
  );
  // Undefined when another read settled it first: that one stands.
  return fromRecord(failed ?? (await readBrowserVmRunRecord(runId)) ?? record);
}

export async function readBrowserVmRunStatus(runId: string) {
  return (await readBrowserVmRun(runId)).status;
}

/**
 * Stop a run's agent; the page it was on stays in its tab. Whenever the VM
 * may be running — it has an address and is neither stopped nor being
 * deleted — its worker is asked, and a worker that does not answer fails
 * the cancel, as a Browser Use cancel that did not get through does: the
 * run may still be acting for the person, and the caller must not take it
 * as stopped. The worker answers once the run has ended, or after its wait
 * (20 s) with the agent still on its step: the record is closed as
 * cancelled once the worker takes the cancel, but the answer then still
 * says running, so the caller does not take the VM's browser as free yet. A
 * run the worker never had, or one on a VM that is off, is closed in the
 * record alone; a settled one has nothing left to stop.
 */
export async function cancelBrowserVmRun(runId: string) {
  const now = new Date();
  const [record, vm] = await Promise.all([
    readBrowserVmRunRecord(runId),
    readBrowserVm(browserVmWorkspace(runId)),
  ]);
  const settled = record !== undefined && settledStatuses.has(record.status);
  const running = vm === undefined || settled ? undefined : mayBeRunning(vm);
  let stopping: WorkerRun | undefined;
  if (running !== undefined) {
    try {
      const run = await onWorker(async () =>
        cancelBrowserVmWorkerRun(running, runId)
      );
      if (record === undefined || settledStatuses.has(run.status)) {
        await mirror(record, run, now);
        return fromWorker(run, record);
      }
      stopping = run;
    } catch (error) {
      // A run the worker never had is closed in the record alone.
      if (!missing(error) || record === undefined) throw error;
    }
  }
  if (record === undefined) {
    throw new BrowserUseError(404, "browser-vm", "No such run.");
  }
  if (settled) return fromRecord(record);
  const cancelled = await updateBrowserVmRun(
    runId,
    { finishedAt: now, status: "cancelled" },
    now
  );
  return stopping === undefined
    ? fromRecord(cancelled ?? record)
    : fromWorker(stopping, record);
}

/**
 * A message into a VM session: the live run reads it before its next step,
 * or an idle session continues in its tab as a new run, recorded first like
 * any start. A VM that is not up has no session to continue: the 409 sends
 * the caller to start a follow-up run, which powers it on.
 *
 * Only a message that may start a run has the proxy seen to first: setting
 * it again repoints the Chrome a live run is working in, mid-step. Even
 * then the errand keeps its exit: the session is signed in from it. A
 * message the live run ends without reading is not lost: the run's terminal
 * summary carries it as `unreadMessages`, reported in the errand's own
 * report for the coordinator to act on, rather than followed up here.
 */
export async function queueBrowserVmSessionMessage(
  sessionId: string,
  text: string
) {
  const workspaceId = browserVmWorkspace(sessionId);
  const running = await readyVm(workspaceId);
  if (running === undefined) {
    throw new BrowserUseError(
      409,
      "browser-vm",
      "The browser VM is not running."
    );
  }
  const now = new Date();
  const session = await onWorker(async () =>
    readBrowserVmWorkerSession(running, sessionId)
  );
  const vm =
    session?.status === "running"
      ? running
      : await prepareBrowserVmSession(running, now, { rotate: false });
  const runId = newBrowserVmRunId(workspaceId);
  await recordBrowserVmRun({ id: runId, sessionId, task: text, workspaceId });
  let queued: Awaited<ReturnType<typeof sendBrowserVmWorkerMessage>>;
  const llm = browserVmLlm();
  try {
    queued = await sendBrowserVmWorkerMessage(vm, sessionId, {
      llm,
      runId,
      text,
      tuning: runTuning(llm.model),
    });
  } catch (error) {
    // Refused: no run was started under the id. An answer lost on the way
    // leaves the record for the next read to settle with the worker.
    if (!(error instanceof BrowserVmWorkerError)) throw error;
    await updateBrowserVmRun(runId, {
      error: neverStarted,
      status: "cancelled",
    });
    throw new BrowserUseError(error.status, "browser-vm", error.body);
  }
  // The message joined the live run: the recorded follow-up never runs. The
  // worker has the message either way, so neither write fails the call.
  if (queued.runId !== runId) {
    await afterAccepted(runId, async () => {
      await updateBrowserVmRun(runId, {
        error: "The message joined the session's live run.",
        status: "cancelled",
      });
    });
  }
  await afterAccepted(runId, async () => keepAwake(vm, now));
  return {
    id: 0,
    runId: queued.runId,
    sessionId: queued.sessionId,
    status: queued.status,
  };
}

/**
 * The debugger endpoint of the session's tab while the VM keeps it, scoped
 * to that tab: the worker lists it first, and the CDP client types into it.
 */
export async function findBrowserVmSessionCdpUrl(sessionId: string) {
  const vm = await readyVm(browserVmWorkspace(sessionId));
  if (vm === undefined) return undefined;
  const session = await onWorker(async () =>
    readBrowserVmWorkerSession(vm, sessionId)
  );
  return session?.tabOpen === true
    ? browserVmCdpUrl(vm, { sessionId })
    : undefined;
}

/**
 * Close the session's tab once the run that just settled is still its
 * latest and has ended, as `stopBrowserUseSessionBrowsers` stops a Browser
 * Use session's browsers. A VM that is not up holds no tab: its Chrome
 * stopped with it.
 */
export async function stopBrowserVmSessionBrowsers(
  sessionId: string,
  settledRunId: string
) {
  const vm = await readyVm(browserVmWorkspace(sessionId));
  if (vm === undefined) return "stopped" as const;
  const session = await onWorker(async () =>
    readBrowserVmWorkerSession(vm, sessionId)
  );
  if (session === undefined) return "stopped" as const;
  if (session.latestRunId !== settledRunId) return "moved_on" as const;
  if (session.status === "running") return "running" as const;
  return onWorker(async () => releaseBrowserVmWorkerSession(vm, sessionId));
}

/** End a session: its tab is closed once no run of it is live. */
export async function stopBrowserVmSession(sessionId: string) {
  await stopBrowserVmTab(sessionId, async (vm) => {
    await releaseBrowserVmWorkerSession(vm, sessionId);
  });
}

/**
 * A blank tab of its own for a keep-alive visit, on the VM's one profile.
 * A keep-alive never powers the VM on — a sign-in is not worth a VM's
 * minute — so a VM that is off answers 429, which ends the visit.
 */
export async function createBrowserVmBrowser(input: {
  readonly profileId: string;
}) {
  const workspaceId = browserVmWorkspace(input.profileId);
  const running = await readyVm(workspaceId);
  if (running === undefined) {
    throw new BrowserUseError(
      429,
      "browser-vm",
      "The browser VM is off; a keep-alive visit does not start it."
    );
  }
  // Continues the workspace's one profile, like a queued message or a
  // follow-up run: a keep-alive visit exists to hold the sign-in steady, so
  // it must not itself move the address the site sees it from.
  const vm = await prepareBrowserVmSession(running, new Date(), {
    rotate: false,
  });
  const targetId = await onWorker(async () => openBrowserVmWorkerTab(vm));
  return {
    cdpUrl: browserVmCdpUrl(vm, { targetId }),
    id: browserVmBrowserId(workspaceId, targetId),
  };
}

/** Close a keep-alive tab. One on a VM that is off went with its Chrome. */
export async function stopBrowserVmBrowser(browserId: string) {
  const targetId = browserVmTargetOf(browserId);
  await stopBrowserVmTab(browserId, async (vm) => {
    await closeBrowserVmWorkerTab(vm, targetId);
  });
}

/**
 * Forget every sign-in on the VM: its Chrome profile is wiped, and the
 * profile generation moves on, so the next errand gets a new profile id and
 * everything recorded against the old one reads as forgotten. A VM that is
 * off is wiped as soon as it is up again, before any errand runs on it; a
 * sandbox of the pool also loses its sets. An older profile id is forgotten
 * already.
 */
export async function deleteBrowserVmProfile(profileId: string) {
  const workspaceId = browserVmWorkspace(profileId);
  const record = await readBrowserVm(workspaceId);
  if (
    record === undefined ||
    browserVmProfileId(workspaceId, record.profileGeneration) !== profileId
  ) {
    return;
  }
  const vm = up(record);
  if (vm !== undefined) {
    await onWorker(async () => resetBrowserVmWorkerProfile(vm));
  }
  await updateBrowserVm(workspaceId, {
    profileGeneration: record.profileGeneration + 1,
    // A sandbox of the pool also keeps the profile in its sets in Object
    // Storage: the flag has the reconcile delete them, even once the live
    // profile is wiped (`agent/lib/browser-pool/sandbox.ts`).
    profileResetPending: vm === undefined || record.sandboxState !== null,
  });
}

/**
 * The files a session's runs saved under a prefix, each with a download URL
 * that works with a plain GET for two minutes, as Browser Use's presigned
 * ones did. A VM that is off lists none.
 */
export async function listBrowserVmWorkspaceFiles(
  sessionId: string,
  prefix: string
) {
  const vm = await readyVm(browserVmWorkspace(sessionId));
  if (vm === undefined) return { files: [] };
  const files = await onWorker(async () =>
    listBrowserVmWorkerFiles(vm, sessionId, prefix)
  );
  return {
    files: files.map((file) => ({
      lastModified: file.lastModified,
      path: file.path,
      size: file.size,
      url: browserVmFileUrl(vm, sessionId, file.path),
    })),
  };
}

/**
 * A VM run has no event feed: its only use was Browser Use's live view,
 * which a VM errand does not offer.
 */
export function listBrowserVmRunEvents() {
  return { events: [] };
}

/**
 * The newest run of the profile's workspace from the last day whose task
 * carries this exact line: how a start whose answer was lost is adopted
 * rather than started twice. The record answers even while the VM is off.
 *
 * A record still `dispatching` may never have reached the worker, so while
 * the VM is up the worker is asked first: a run it does not have never
 * started, and its record is closed so the errand is started afresh. A
 * worker that does not answer leaves the question open, and the lookup
 * fails for the caller to try again, rather than start the errand twice or
 * adopt a run that never was. On a VM that is not up there is no one to
 * ask, and the record is adopted as it is: a start that may have acted is
 * not repeated, and reading it closes it as failed once the VM is off.
 */
export async function findBrowserVmRunByTaskLine(
  profileId: string,
  line: string
) {
  const workspaceId = browserVmWorkspace(profileId);
  const record = await findBrowserVmRunRecordByTaskLine(workspaceId, line);
  if (record === undefined) return undefined;
  const vm =
    record.status === "dispatching" ? await readyVm(workspaceId) : undefined;
  if (vm === undefined) return fromRecord(record);
  const run = await onWorker(async () => readBrowserVmWorkerRun(vm, record.id));
  if (run === undefined) {
    await updateBrowserVmRun(record.id, {
      error: neverStarted,
      status: "cancelled",
    });
    return undefined;
  }
  await mirror(record, run, new Date());
  return fromWorker(run, record);
}

/**
 * Ask the worker to start the run. A refusal means nothing started, and the
 * record is closed so no lookup adopts it. A start with no answer is looked
 * up once by its id — the worker is idempotent on it — and never sent again
 * blindly.
 */
async function startRun(
  vm: BrowserVm,
  request: Parameters<typeof startBrowserVmWorkerRun>[1]
) {
  try {
    return await startBrowserVmWorkerRun(vm, request);
  } catch (error) {
    if (error instanceof BrowserVmWorkerError) {
      await updateBrowserVmRun(request.id, {
        error: neverStarted,
        status: "cancelled",
      });
      if (error.status !== 409) {
        throw new BrowserUseError(error.status, "browser-vm", error.body);
      }
      throw await busyError(error.busyRunId, request.sessionId);
    }
    const landed = await readBrowserVmWorkerRun(vm, request.id).catch(
      (cause: unknown) => {
        console.warn(
          "[browser-vm] a start with no answer could not be looked up",
          {
            cause,
            runId: request.id,
          }
        );
        return null;
      }
    );
    if (landed) return landed;
    // The worker does not have it: nothing started.
    if (landed === undefined) {
      await updateBrowserVmRun(request.id, {
        error: neverStarted,
        status: "cancelled",
      });
    }
    throw error;
  }
}

/**
 * The VM has one browser. Busy with this very session's run, the session is
 * busy, as a Browser Use session answers 409 and the follow-up is queued on
 * it; busy with another errand, the errand waits its turn in the queue.
 */
async function busyError(busyRunId: string | undefined, sessionId?: string) {
  const busy =
    busyRunId === undefined
      ? undefined
      : await readBrowserVmRunRecord(busyRunId);
  if (busy !== undefined && busy.sessionId === sessionId) {
    return new BrowserUseError(
      409,
      "browser-vm",
      "The session is busy with its own run."
    );
  }
  return new BrowserUseError(
    429,
    "browser-vm",
    "The browser is busy with another errand.",
    busyRetryMs
  );
}

/**
 * What the worker says of a run: `found`, `missing` when it answered that it
 * never had it, or `unknown` when the VM is not up or did not answer — a
 * worker that is restarting, a token it no longer takes.
 */
async function askWorker(vm: BrowserVm | undefined, runId: string) {
  const ready = vm === undefined ? undefined : up(vm);
  if (ready === undefined) return { kind: "unknown" as const };
  try {
    const run = await readBrowserVmWorkerRun(ready, runId);
    return run === undefined
      ? { kind: "missing" as const }
      : { kind: "found" as const, run, vm: ready };
  } catch (error) {
    console.warn("[browser-vm] the worker could not be asked about a run", {
      cause: error,
      runId,
    });
    return { kind: "unknown" as const };
  }
}

/**
 * Write what the worker says into the record, when it says anything new. A
 * run this VM's poller started itself, for messages an earlier run ended
 * without reading, is recorded before it starts (`createBrowserVmRun`), so
 * `record` is only undefined here for a run this call is seeing for the
 * first time some other way.
 */
async function mirror(
  record: BrowserVmRunRecord | undefined,
  run: WorkerRun,
  now: Date
) {
  await recordRunCosts(record, run, now);
  if (record === undefined) {
    await recordBrowserVmRun({
      id: run.id,
      sessionId: run.sessionId,
      status: run.status,
      task: run.task,
      workspaceId: browserVmWorkspace(run.id),
    });
  } else if (
    record.status === run.status &&
    record.result === run.result &&
    record.error === run.error &&
    record.finalUrl === run.finalUrl
  ) {
    return;
  }
  const finishedAt =
    run.finishedAt === null ? Number.NaN : Date.parse(run.finishedAt);
  if (modelRefusedForBilling(run.error)) await reportModelOutOfBalance(run.id);
  await updateBrowserVmRun(
    run.id,
    {
      error: run.error,
      finalUrl: run.finalUrl,
      finishedAt: settledStatuses.has(run.status)
        ? new Date(Number.isNaN(finishedAt) ? now.getTime() : finishedAt)
        : null,
      result: run.result,
      status: run.status,
      // Messages queued into the run that it never got to read: the
      // worker never starts a follow-up on its own (D1). Neither does Bro
      // any more — its settle path surfaces them in the run's report for
      // the coordinator to act on (`agent/lib/browser-use/completion.ts`).
      unreadMessages: run.unreadMessages ?? [],
    },
    now
  );
}

/**
 * What a run spent, once the worker reports it settled and the record has
 * not taken that yet. A cancel closes the record before the worker's run
 * has ended, so a cancelled one is recorded on every read: the key is the
 * run id, and the reads after the first add nothing. Nothing here fails the
 * read.
 */
async function recordRunCosts(
  record: BrowserVmRunRecord | undefined,
  run: WorkerRun,
  now: Date
) {
  if (!settledStatuses.has(run.status)) return;
  if (
    record !== undefined &&
    settledStatuses.has(record.status) &&
    record.status !== "cancelled"
  ) {
    return;
  }
  try {
    await recordBrowserVmRunCosts(
      record?.workspaceId ?? browserVmWorkspace(run.id),
      run,
      now
    );
  } catch (error) {
    console.warn("[usage-costs] a VM run's costs were not recorded", {
      error: error instanceof Error ? error.message : String(error),
      runId: run.id,
    });
  }
}

/**
 * The run summary Browser Use answers with. Its files live in the session's
 * own folder on the VM, so the session id is the "workspace" they are
 * listed by; the task is the composed one Bro recorded. `unreadMessages`
 * are the messages queued into this run that it ended without reading.
 */
function fromWorker(run: WorkerRun, record: BrowserVmRunRecord | undefined) {
  return {
    createdAt: run.createdAt,
    error: explainedError(run.error),
    id: run.id,
    result: run.result,
    sessionId: run.sessionId,
    status: run.status,
    task: record?.task ?? run.task,
    unreadMessages: run.unreadMessages ?? [],
    workspaceId: run.sessionId,
  };
}

function fromRecord(record: BrowserVmRunRecord) {
  return {
    createdAt: record.createdAt.toISOString(),
    error: explainedError(record.error),
    id: record.id,
    result: record.result,
    sessionId: record.sessionId,
    status: record.status,
    task: record.task,
    unreadMessages: record.unreadMessages ?? [],
    workspaceId: record.sessionId,
  };
}

/** The VM when it is up with an address; any other state has no worker. */
function up(vm: BrowserVm) {
  return vm.state === "ready" && vm.host !== null ? vm : undefined;
}

/**
 * The VM when a run may still be going on it: one with an address that is
 * neither stopped nor being deleted, whatever Bro last saw of its worker —
 * a VM marked starting while its worker was slow to answer may still be
 * running the errand.
 */
function mayBeRunning(vm: BrowserVm) {
  return vm.host !== null &&
    (vm.vmId !== null || vm.hostId !== null) &&
    vm.state !== "stopped" &&
    vm.state !== "deleting"
    ? vm
    : undefined;
}

async function readyVm(workspaceId: string) {
  const vm = await readBrowserVm(workspaceId);
  return vm === undefined ? undefined : up(vm);
}

/**
 * Bookkeeping once the worker has taken a run or a message: the run is
 * acting for the person already, so a write that fails here is logged and
 * does not fail the call, whose caller would otherwise lose track of it.
 */
async function afterAccepted(runId: string, write: () => Promise<void>) {
  try {
    await write();
  } catch (error) {
    console.warn("[browser-vm] a run the worker took could not be recorded", {
      cause: error,
      runId,
    });
  }
}

/** A read or a start keeps the VM from its idle stop. */
async function keepAwake(vm: BrowserVm, now: Date) {
  if (
    vm.lastUsedAt !== null &&
    vm.lastUsedAt.getTime() > now.getTime() - touchEveryMs
  ) {
    return;
  }
  await touchBrowserVm(vm.workspaceId, now);
}

/**
 * Close a tab of the VM that `id` names the workspace of. There is nothing
 * to close on a VM that is off, or for a tab or session the worker no
 * longer has.
 */
async function stopBrowserVmTab(
  id: string,
  close: (vm: BrowserVm) => Promise<void>
) {
  const vm = await readyVm(browserVmWorkspace(id));
  if (vm === undefined) return;
  try {
    await onWorker(async () => close(vm));
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

/**
 * A worker refusal as the Browser Use error its callers already act on: a
 * 404 for a session or run the VM does not have, a 409 for a busy session.
 */
async function onWorker<T>(call: () => Promise<T>) {
  try {
    return await call();
  } catch (error) {
    if (error instanceof BrowserVmWorkerError) {
      throw new BrowserUseError(error.status, "browser-vm", error.body);
    }
    throw error;
  }
}

function missing(error: unknown): error is BrowserUseError {
  return error instanceof BrowserUseError && error.status === 404;
}

/**
 * The model the VM's agent runs on answered 402 (RouterAI: «Insufficient
 * balance»). The raw error read to Bro's model as the cloud browser running
 * out of credits, and to the person as a fault of the service they use; it
 * is the owner's balance, so they are told, and the person hears plainly
 * that nothing was done.
 */
const modelBillingError = /\b402\b|insufficient balance/iu;
const modelBalanceAlertRepeatMs = 6 * 60 * 60_000;

function modelRefusedForBilling(error: string | null | undefined) {
  return modelBillingError.test(error ?? "");
}

function explainedError(error: string | null | undefined) {
  if (!modelRefusedForBilling(error)) return error;
  return "Nothing was done on the site: the AI model the browser's agent runs on refused the run for billing reasons (402, insufficient balance), which only the service owner can fix and has been told about. Tell the user in one short sentence that the browser is unavailable for a while and that nothing was ordered or charged; it is not about their card or the site.";
}

async function reportModelOutOfBalance(runId: string) {
  console.error("[browser-vm] the agent's model refused the run: no balance", {
    runId,
  });
  try {
    await alertOwner(
      "browser-vm-model-balance",
      [
        "Модель агента на VM браузера ответила 402: на RouterAI кончился баланс.",
        "Поручения на своих VM обрываются, ничего на сайтах не делается. Пополни баланс RouterAI (ключ BROWSER_VM_LLM_API_KEY).",
      ].join("\n"),
      { repeatAfterMs: modelBalanceAlertRepeatMs }
    );
  } catch (error) {
    console.warn("[browser-vm] the owner could not be alerted", {
      cause: error,
    });
  }
}
