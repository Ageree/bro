import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  closeQueuedBrowserRun,
  countQueuedBrowserRuns,
  createQueuedBrowserRun,
  handOffBrowserRunRetry,
  parkQueuedBrowserRun,
  readBrowserRun,
} from "@db/services/browser-runs";
import {
  BrowserUseError,
  type BrowserUseCreateRunInput,
  browserUseBusy,
  browserUseOutOfCredits,
  cancelBrowserUseRun,
  createBrowserUseRun,
  findRecentBrowserUseRunByTaskLine,
} from "./client";
import {
  browserUseCreditsRestored,
  reportBrowserUseOutOfCredits,
} from "./credits";
import { customProxy } from "./proxy";
import { resolveBrowserSecretBindings, signsInByPhone } from "./secrets";
import { accountInUse } from "./sign-ins";
import { releaseBrowserRunSpend } from "./spend";

type BrowserRunRow = NonNullable<Awaited<ReturnType<typeof readBrowserRun>>>;

/**
 * Browser Use runs only so many browsers at once, and past that answers 429
 * to every start. A turn used to retry the start on the spot — one did 77
 * times — which only kept the cap full. The errand waits here instead: the
 * poller tries the longest-waiting one each minute, and a busy answer ends
 * that minute's tries, since the next errand would get the same answer.
 */
const queueRetryMs = 60_000;
/** A throttle may ask for a longer pause; five minutes is the most we wait. */
const maximumQueueRetryMs = 5 * 60_000;
/** Past this the person hears that the errand did not start, not silence. */
const queueWindowMs = 90 * 60_000;

export function queueRetryAt(now: Date, retryAfterMs?: number) {
  const wait = Math.min(
    Math.max(retryAfterMs ?? queueRetryMs, queueRetryMs),
    maximumQueueRetryMs
  );
  return new Date(now.getTime() + wait);
}

/**
 * A rough promise for the person: each errand ahead takes a slot as one frees
 * up, and slots free up every few minutes. It is said as «about», never as a
 * time.
 */
function expectedStartMinutes(ahead: number) {
  return Math.min(2 + ahead * 3, 30);
}

/**
 * Whether new errands go straight to the back of the line: while anything is
 * queued, the cap was full a minute ago, and a start now would only take the
 * slot the queued errand is about to get — or add one more 429.
 */
export async function browserQueueOccupied() {
  return (await countQueuedBrowserRuns()) > 0;
}

/**
 * Queue an errand that could not start now. It keeps everything the person
 * decided for it — the composed instruction, the card they confirmed, the
 * card they allowed to pay with — so the run the poller starts later is the
 * same errand they asked for, and follows-ups on its id reach that run.
 */
export async function queueBrowserErrand(
  scope: AccessScope,
  input: Omit<
    Parameters<typeof createQueuedBrowserRun>[1],
    "pendingTask" | "retryAt"
  > & {
    readonly composedTask: string;
    readonly retryAfterMs?: number;
  },
  now = new Date()
) {
  const { composedTask, retryAfterMs, ...row } = input;
  const account = row.waitsForAccount ?? undefined;
  const ahead = account === undefined ? await countQueuedBrowserRuns() : 0;
  const queued = await createQueuedBrowserRun(scope, {
    ...row,
    pendingTask: composedTask,
    retryAt: queueRetryAt(now, retryAfterMs),
  });
  if (account !== undefined) {
    return {
      minutes: undefined,
      note: signInWaitNote(account),
      runId: queued.id,
    };
  }
  const minutes = expectedStartMinutes(ahead);
  return {
    minutes,
    note: queuedErrandNote(ahead, minutes),
    runId: queued.id,
  };
}

const queuedErrandRules =
  "Do not call browser_task start again for this errand: it would only queue a second copy. status, continue and cancel work on this run id, and follow the errand to its run once it starts.";

/**
 * What Bro is told about an errand that waits for another errand's browser
 * on the same account (`accountInUse`): not a busy service, and not a time.
 */
function signInWaitNote(account: string) {
  return [
    `Another errand of the user is working in Bro's browser on ${account} right now, or waiting there for the user's code or approval: a second sign-in at the same time would send the user a second code that cancels the first. So this errand waits and starts by itself as soon as that browser is done, on the same browser profile, so that the two never ask for codes at once. Do not promise the user that no code will be needed: the site may still ask for one, and then the run stops and you ask.`,
    "Tell the user in one short line that it starts right after the other one; the outcome arrives as a new message like any other.",
    queuedErrandRules,
  ].join(" ");
}

function queuedErrandNote(ahead: number, minutes: number) {
  return [
    `The cloud browser service has no free browser right now${ahead > 0 ? ` and ${String(ahead)} other errand${ahead === 1 ? " is" : "s are"} waiting` : ""}, so this errand is queued and starts by itself as soon as one frees up — in about ${String(minutes)} minutes.`,
    `Tell the user in one short line that you queued it and will start in about ${String(minutes)} minutes; the outcome arrives as a new message like any other.`,
    queuedErrandRules,
  ].join(" ");
}

/** The model-facing note for `status` on an errand still in the queue. */
export function queuedStatusNote(
  row: Pick<BrowserRunRow, "retryAt" | "waitsForAccount">
) {
  const account = row.waitsForAccount ?? undefined;
  if (account !== undefined) {
    return `The errand is still waiting for another errand of the user to finish in Bro's browser on ${account}, so that it starts signed in instead of sending a second code; it starts by itself right after. Say so in one short line; do not start it again.`;
  }
  const next = row.retryAt
    ? ` The next try is at ${row.retryAt.toISOString()}.`
    : "";
  return `The errand is still queued: the cloud browser service had no free browser for it yet, and it starts by itself as soon as one frees up.${next} Say so in one short line; do not start it again.`;
}

/**
 * The line that finds a run started for this errand again after a poller
 * died. It names the revision too: a run started before the person changed
 * the errand carries the old instruction and must not be adopted for the new.
 */
function queueReference(row: Pick<BrowserRunRow, "id" | "queueRevision">) {
  const revision =
    row.queueRevision > 0 ? `, change ${String(row.queueRevision)}` : "";
  return `(Queued errand ${row.id}${revision}; for bookkeeping only.)`;
}

async function abandonStartedRun(runId: string) {
  try {
    await cancelBrowserUseRun(runId);
  } catch (error) {
    console.warn(
      "[browser-use] the orphaned queued run could not be cancelled",
      {
        cause: error,
        runId,
      }
    );
  }
}

/**
 * A queued follow-up goes back into the browser its errand was using. When
 * that session is gone or busy, it opens a fresh browser on the same profile
 * instead, where the sign-ins live.
 */
async function createRunInSession(input: BrowserUseCreateRunInput) {
  try {
    return await createBrowserUseRun(input);
  } catch (error) {
    if (
      input.sessionId === undefined ||
      !(error instanceof BrowserUseError) ||
      ![400, 404, 409].includes(error.status)
    ) {
      throw error;
    }
    return createBrowserUseRun({ ...input, sessionId: undefined });
  }
}

/**
 * Close a queued errand that is not going to start. What it held is given
 * back; the caller reports the outcome to the person through the report path
 * every settled run uses, so it survives a delivery that fails now.
 */
async function giveUpQueuedErrand(row: BrowserRunRow, outcome: string) {
  const closed = await closeQueuedBrowserRun(row.id, {
    outcome,
    status: "failed",
  });
  if (closed) await releaseBrowserRunSpend(closed.id);
  return closed;
}

/**
 * Start a cloud run for the errand as the person left it: the instruction
 * composed when they asked, on the workspace profile and in the browser a
 * follow-up was using, with the site's secrets bound afresh.
 */
async function createQueuedRun(row: BrowserRunRow, reference: string) {
  const task = row.pendingTask ?? row.task;
  const secrets = await resolveBrowserSecretBindings(
    { userId: row.createdByUserId, workspaceId: row.workspaceId },
    {
      allowPayment: row.paymentAllowed,
      // The phone goes again only where the errand was composed with it.
      phoneSignIn: signsInByPhone(task),
      site: row.site ?? undefined,
    }
  );
  return createRunInSession({
    customProxy: customProxy(),
    maxCostUsd: env.BROWSER_USE_MAX_COST_USD,
    model: env.BROWSER_USE_MODEL,
    profileId: row.profileId ?? undefined,
    proxyCountryCode: env.BROWSER_USE_PROXY_COUNTRY,
    secretBindings: secrets.bindings,
    sessionId: row.sessionId ?? undefined,
    task: `${task}\n\n${reference}`,
  });
}

/**
 * Start one queued errand. The row is read again first, since the person may
 * have cancelled it; a run started for an errand stopped in the meantime is
 * cancelled. A `continue` that lands while the run is being started changed
 * what the errand should start with: the hand-off refuses the run built from
 * the revision read before it, which is cancelled, and the errand goes back to
 * the front of the line to start again with the change (`changed`). A poller
 * that died between starting the run and handing the errand over left a run
 * carrying the errand's reference line. The next claim looks for it before
 * anything else — before the queue window can close the errand and before
 * the vault is asked for secrets — and adopts it instead of starting a second
 * browser or leaving the first one working untracked.
 */
export async function startQueuedBrowserRun(
  row: BrowserRunRow,
  now = new Date()
): Promise<
  | {
      readonly status: "busy" | "changed" | "started" | "stopped" | "waiting";
    }
  | {
      readonly closed: BrowserRunRow | undefined;
      readonly outcome: string;
      readonly status: "expired" | "no_credits";
    }
> {
  const current = await readBrowserRun(row.id);
  if (current?.status !== "queued" || current.retriedAsRunId) {
    return { status: "stopped" };
  }
  const expired = now.getTime() - current.createdAt.getTime() > queueWindowMs;
  const reference = queueReference(current);
  const waitedFor = current.waitsForAccount ?? undefined;
  let run: { readonly id: string; readonly sessionId: string } | undefined;
  try {
    // An errand marked as waiting was not started since the mark was set:
    // it is cleared before a start, so there is no run of it to adopt.
    run =
      waitedFor === undefined
        ? await findRecentBrowserUseRunByTaskLine(reference)
        : undefined;
    if (!run && !expired) {
      // A new errand waits while another errand of its workspace holds a
      // browser on the same account; a queued follow-up carries its errand's
      // session and is that errand itself, so it never waits on it.
      const account =
        current.sessionId === null
          ? await accountInUse(current.workspaceId, current.site, now)
          : undefined;
      if (account !== undefined) {
        await parkQueuedBrowserRun(current.id, queueRetryAt(now), {
          waitsForAccount: account,
        });
        return { status: "waiting" };
      }
      if (waitedFor !== undefined) {
        // From here it waits only for a browser, like any queued errand.
        await parkQueuedBrowserRun(
          current.id,
          current.retryAt ?? queueRetryAt(now),
          { waitsForAccount: null }
        );
      }
      run = await createQueuedRun(current, reference);
    }
  } catch (error) {
    if (browserUseBusy(error)) {
      await parkQueuedBrowserRun(
        current.id,
        queueRetryAt(now, error.retryAfterMs)
      );
      return { status: "busy" };
    }
    if (browserUseOutOfCredits(error)) {
      await reportBrowserUseOutOfCredits(error);
      const outcome =
        "The errand never started: the cloud browser service became unavailable (it refused new runs for billing reasons, which only the service owner can fix). Nothing was done on the site. Tell the user so honestly in one short line and offer to start it again later.";
      return {
        closed: await giveUpQueuedErrand(current, outcome),
        outcome,
        status: "no_credits",
      };
    }
    throw error;
  }
  if (!run) {
    const waited = `${String(Math.round(queueWindowMs / 60_000))} minutes`;
    const outcome =
      waitedFor === undefined
        ? `The errand never started: the cloud browser service had no free browser for it for ${waited}. Nothing was done on the site. Tell the user so plainly and offer to start it again.`
        : `The errand never started: it waited ${waited} for another errand of the user on ${waitedFor} to finish in Bro's browser, which never did. Nothing was done on the site. Tell the user so plainly and offer to start it again.`;
    return {
      closed: await giveUpQueuedErrand(current, outcome),
      outcome,
      status: "expired",
    };
  }
  await browserUseCreditsRestored();
  let handedOff: boolean;
  try {
    handedOff = await handOffBrowserRunRetry(
      current.id,
      {
        conversationChannel: current.conversationChannel,
        conversationId: current.conversationId,
        id: run.id,
        paymentAllowed: current.paymentAllowed,
        profileId: current.profileId,
        replyAnchorMessageId: current.replyAnchorMessageId,
        rootSessionId: current.rootSessionId,
        sessionId: run.sessionId,
        site: current.site,
        status: "running",
        // The run is the errand the person confirmed on the card, so it
        // carries that confirmation — and only that one.
        submission: current.submission,
        task: current.task,
      },
      { queueRevision: current.queueRevision }
    );
  } catch (error) {
    await abandonStartedRun(run.id);
    throw error;
  }
  if (!handedOff) {
    await abandonStartedRun(run.id);
    // Still queued means the person changed it while the run was starting:
    // it is due again at once, and starts with the change.
    return (await parkQueuedBrowserRun(current.id, now))
      ? { status: "changed" }
      : { status: "stopped" };
  }
  return { status: "started" };
}
