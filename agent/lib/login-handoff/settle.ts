import { recordHandoffSignIn } from "@agent/lib/browser-use/sign-ins";
import {
  cancelBrowserVmWorkerHandoff,
  readBrowserVmWorkerHandoff,
} from "@agent/lib/browser-vm/worker";
import {
  readBrowserVm,
  updateBrowserVm,
  clearBrowserVmStopNotBefore,
} from "@db/services/browser-vms";
import type { loginHandoffs } from "@db/schema/login-handoffs";
import {
  endLoginHandoff,
  expireLoginHandoffs,
  listClaimedLoginHandoffs,
} from "@db/services/login-handoffs";
import { env } from "@shared/environment";
import {
  type HandoffEnding,
  loginHandoffReport,
  looksSignedIn,
} from "./report";

type Row = typeof loginHandoffs.$inferSelect;

/** How long past its window a handoff that cannot be read is waited for. */
const graceMs = 3 * 60_000;

/**
 * The sign-in is over and Chrome has written what the site gave the person:
 * the sandbox is parked at once rather than at the end of its idle window,
 * so the profile reaches storage now and not after a crash could have lost
 * it (a parked sandbox starts again in seconds). Never fatal.
 */
export async function saveProfileSoon(workspaceId: string, now: Date) {
  try {
    await clearBrowserVmStopNotBefore(workspaceId, now);
    await updateBrowserVm(
      workspaceId,
      {
        lastUsedAt: new Date(
          now.getTime() - env.BROWSER_VM_IDLE_MINUTES * 60_000 - 1_000
        ),
      },
      now
    );
  } catch (error) {
    console.warn("[login-handoff] the profile could not be marked for saving", {
      cause: error,
    });
  }
}

async function end(row: Row, ending: HandoffEnding, now: Date) {
  const done = ending.kind === "done";
  const settled = await endLoginHandoff(
    row.id,
    {
      report: loginHandoffReport(row.domain, ending),
      signedIn: done ? ending.signedIn : null,
      state: done ? "done" : ending.kind,
    },
    now
  );
  return settled;
}

/**
 * Read a claimed handoff off its worker and end it when the worker says it is
 * over (or cannot say, past its window): the person's «Готово» ends it at
 * once through the page, and this is what finds the ones whose viewer went
 * away. Only the first to end it writes the report. Returns what it did.
 */
export async function settleLoginHandoff(row: Row, now = new Date()) {
  if (row.state !== "claimed" || row.workerId === null) return "skipped";
  const overdue =
    row.viewUntil !== null && now.getTime() > row.viewUntil.getTime() + graceMs;
  const vm = await readBrowserVm(row.workspaceId);
  let seen: Awaited<ReturnType<typeof readBrowserVmWorkerHandoff>> | "unread" =
    "unread";
  if (vm !== undefined && vm.host !== null) {
    try {
      seen = await readBrowserVmWorkerHandoff(vm, row.workerId);
    } catch (error) {
      console.warn("[login-handoff] the worker did not answer", {
        cause: error,
        workspaceId: row.workspaceId,
      });
    }
  }
  if (seen === "unread") {
    if (!overdue) return "skipped";
    await end(row, { kind: "failed" }, now);
    return "failed";
  }
  if (seen === undefined) {
    // The worker has no such handoff: it restarted, or was parked, under it.
    const expired = row.viewUntil !== null && now > row.viewUntil;
    await end(row, { kind: expired ? "expired" : "failed" }, now);
    return expired ? "expired" : "failed";
  }
  if (seen.state === "done") {
    const signedIn = seen.result === null ? null : looksSignedIn(seen.result);
    const settled = await end(row, { kind: "done", signedIn }, now);
    if (settled !== undefined) {
      if (signedIn === true && seen.result !== null) {
        await recordHandoffSignIn(row.workspaceId, {
          domain: row.domain,
          now,
          page: seen.result.url,
        });
      }
      await saveProfileSoon(row.workspaceId, now);
    }
    return "done";
  }
  if (seen.state === "cancelled") {
    await endLoginHandoff(row.id, { report: null, state: "cancelled" }, now);
    return "cancelled";
  }
  if (seen.state === "expired") {
    await end(row, { kind: "expired" }, now);
    await saveProfileSoon(row.workspaceId, now);
    return "expired";
  }
  if (overdue && vm !== undefined) {
    await cancelBrowserVmWorkerHandoff(vm, row.workerId).catch(() => undefined);
    await end(row, { kind: "expired" }, now);
    await saveProfileSoon(row.workspaceId, now);
    return "expired";
  }
  return "skipped";
}

/**
 * The minute tick: links nobody opened expire, and every handoff open on a
 * browser is read off its worker. One that failed to settle does not hold up
 * the rest.
 */
export async function settleLoginHandoffs(now = new Date()) {
  await expireLoginHandoffs(now);
  const claimed = await listClaimedLoginHandoffs();
  for (const row of claimed) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each handoff is on its own worker; one at a time keeps a bad one from holding a burst of calls.
      await settleLoginHandoff(row, now);
    } catch (error) {
      console.warn("[login-handoff] a handoff could not be settled", {
        cause: error,
        workspaceId: row.workspaceId,
      });
    }
  }
}
