import {
  openSandbox,
  SandboxHostError,
  type SandboxOpenRequest,
  settleSandbox,
} from "./host";

/**
 * Room on the shared code host (`sandbox/README.md`, «Лимиты хоста»):
 * `sandboxd` admits a sandbox only while the memory of the live ones, their
 * headroom included, fits under the host's limit (else 507 `host_full`), and
 * stops an idle one by itself only after 20 minutes. So Bro gives back what
 * it no longer needs: the sandboxes this process opened for a session are
 * stopped once the session's turn ends (`releaseSessionSandboxes`),
 * `/workspace` snapshotted first, and the next step that needs one restores
 * it from that snapshot. An open the host refuses as full waits a while for
 * room (`openWithRoom`).
 *
 * What is held here lives in this process only: one eve serves the world's
 * sessions (docs/dev-notes.md), and a sandbox a restart forgot is left to
 * the host's idle stop.
 */

/** Pauses between opens of a full host: 90 s in all, then the open fails. */
const hostFullWaitsMs = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
/** A release that finds a call still running looks again after this. */
const busyRecheckMs = 5_000;
/** Sessions whose turn never ended (parked, cut short) are forgotten past this many. */
const maximumSessions = 1_000;

interface HeldSandbox {
  /** Opens and calls in flight here: no stop is sent while one runs. */
  busy: number;
  /** Opens so far: a release decided before the latest open is void. */
  opens: number;
  /** A release waiting out its grace, and how to send it at once. */
  pending:
    | {
        readonly send: () => Promise<boolean>;
        readonly timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  /** The stop on its way: an open waits for it, so the host restores after. */
  stopping: Promise<void> | undefined;
}

const sandboxes = new Map<string, HeldSandbox>();
/** The sandboxes each eve session opened here since its last release. */
const sessions = new Map<string, Set<string>>();

function held(sandboxId: string) {
  const known = sandboxes.get(sandboxId);
  if (known !== undefined) return known;
  const fresh: HeldSandbox = {
    busy: 0,
    opens: 0,
    pending: undefined,
    stopping: undefined,
  };
  sandboxes.set(sandboxId, fresh);
  return fresh;
}

function unused(sandbox: HeldSandbox) {
  return (
    sandbox.busy === 0 &&
    sandbox.pending === undefined &&
    sandbox.stopping === undefined
  );
}

function cancelPending(sandbox: HeldSandbox) {
  if (sandbox.pending === undefined) return;
  clearTimeout(sandbox.pending.timer);
  sandbox.pending = undefined;
}

function remember(sessionId: string, sandboxId: string) {
  const opened = sessions.get(sessionId) ?? new Set<string>();
  // In order of use, so the session unused longest is forgotten first.
  sessions.delete(sessionId);
  sessions.set(sessionId, opened.add(sandboxId));
  for (const [oldest, sandboxIds] of sessions) {
    if (sessions.size <= maximumSessions) break;
    sessions.delete(oldest);
    for (const id of sandboxIds) {
      const sandbox = sandboxes.get(id);
      if (sandbox !== undefined && unused(sandbox)) sandboxes.delete(id);
    }
  }
}

/** Runs `call` as a use of the sandbox: no release stops it meanwhile. */
export async function inUse<T>(sandboxId: string, call: () => Promise<T>) {
  const sandbox = held(sandboxId);
  sandbox.busy += 1;
  try {
    return await call();
  } finally {
    sandbox.busy -= 1;
  }
}

/**
 * What a log may say of a failed stop: the host's status and code, else the
 * error's name. Not its message: a snapshot that failed names the file.
 */
function refusal(error: Error) {
  return error instanceof SandboxHostError
    ? { code: error.code, status: error.status }
    : { error: error.name };
}

/**
 * Snapshots and stops the sandbox unless it was opened again since the
 * release was decided (that turn releases it in its turn) or a stop is on
 * its way; a call still running puts the stop off a little. True when the
 * host stopped it. A failure is logged, never thrown: the host's idle stop
 * is still there.
 */
async function stopUnused(
  sandboxId: string,
  sandbox: HeldSandbox,
  opens: number
) {
  if (sandbox.opens !== opens || sandbox.stopping !== undefined) return false;
  if (sandbox.busy > 0) {
    arm(sandboxId, sandbox, opens, busyRecheckMs);
    return false;
  }
  const started = Date.now();
  let stopped = false;
  const stop = async () => {
    try {
      await settleSandbox(sandboxId, "stop");
      stopped = true;
      console.info("[sandbox] stopped after its turn", {
        ms: Date.now() - started,
        sandboxId,
      });
    } catch (error) {
      console.warn("[sandbox] not stopped after its turn", {
        ...refusal(error instanceof Error ? error : new Error("thrown")),
        sandboxId,
      });
    } finally {
      sandbox.stopping = undefined;
      if (unused(sandbox) && sandbox.opens === opens) {
        sandboxes.delete(sandboxId);
      }
    }
  };
  sandbox.stopping = stop();
  await sandbox.stopping;
  return stopped;
}

function arm(
  sandboxId: string,
  sandbox: HeldSandbox,
  opens: number,
  delayMs: number
) {
  cancelPending(sandbox);
  const send = async () => {
    cancelPending(sandbox);
    return await stopUnused(sandboxId, sandbox, opens);
  };
  const timer = setTimeout(() => {
    void send();
  }, delayMs);
  // A release waiting out its grace keeps no process alive.
  timer.unref();
  sandbox.pending = { send, timer };
}

/**
 * Lets go of the sandboxes this process opened for the session since its
 * last release: each is stopped `graceMs` later, unless a step opens it
 * again first. A session that opened none costs nothing, and no sandbox is
 * opened for this. Never throws.
 */
export function releaseSessionSandboxes(sessionId: string, graceMs: number) {
  const sandboxIds = sessions.get(sessionId);
  if (sandboxIds === undefined) return;
  sessions.delete(sessionId);
  for (const sandboxId of sandboxIds) {
    const sandbox = sandboxes.get(sandboxId);
    if (sandbox !== undefined) {
      arm(sandboxId, sandbox, sandbox.opens, graceMs);
    }
  }
}

/** Sends now every release still in its grace: how many stopped a sandbox. */
async function stopPendingReleases() {
  const sends = [...sandboxes.values()].flatMap(({ pending }) =>
    pending === undefined ? [] : [pending.send]
  );
  const stopped = await Promise.all(sends.map(async (send) => await send()));
  return stopped.filter(Boolean).length;
}

async function pause(ms: number) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `openSandbox` that waits for room on a full host: this process's own
 * sandboxes still in their grace are stopped at once, then the open is
 * tried again over about 90 s before it fails with a clear error. A stop
 * of this sandbox already on its way finishes first, so the host restores
 * its snapshot. `sessionId` is the eve session the open is for, whose
 * turn's end releases it.
 */
export async function openWithRoom(
  sandboxId: string,
  request: SandboxOpenRequest,
  sessionId: string | undefined
) {
  const sandbox = held(sandboxId);
  cancelPending(sandbox);
  sandbox.opens += 1;
  if (sessionId !== undefined) remember(sessionId, sandboxId);
  return await inUse(sandboxId, async () => {
    await sandbox.stopping;
    let waits = 0;
    let freed = false;
    for (;;) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each try waits for the host's answer to the last.
        return await openSandbox(sandboxId, request);
      } catch (error) {
        if (!(error instanceof SandboxHostError) || error.status !== 507) {
          throw error;
        }
        if (!freed) {
          freed = true;
          // The room nearest at hand is this process's own, once.
          // oxlint-disable-next-line eslint/no-await-in-loop -- The next try needs that room.
          if ((await stopPendingReleases()) > 0) continue;
        }
        const waitMs = hostFullWaitsMs[waits];
        if (waitMs === undefined) {
          throw new Error(
            "The code sandbox host has no room for this sandbox: it stayed full for 90 s.",
            { cause: error }
          );
        }
        waits += 1;
        console.warn("[sandbox] host full, waiting", {
          attempt: waits,
          message: error.message,
          waitMs,
        });
        // oxlint-disable-next-line eslint/no-await-in-loop -- The pause between tries.
        await pause(waitMs);
      }
    }
  });
}
