import { defineState } from "eve/context";
import { defineHook, type HookContext } from "eve/hooks";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  attachmentsPerMessage,
  conversationHoldsPersonFiles,
  getInbox,
  inboxKey,
  markSandboxHoldsPersonFiles,
  namedAttachmentPaths,
  pathMatchesBytes,
  personCallFresh,
  sandboxHasFile,
  sandboxHoldsPersonFiles,
} from "@agent/lib/sandbox/inbox";
import { offlineOwed, recordOfflineOwed } from "@agent/lib/sandbox/offline";
import { taskFilesOfCaller } from "@agent/lib/sandbox/pilot";

/** What the task agent reads when a file Bro named is not there. */
const notReceivedPath = "/workspace/attachments/NOT_RECEIVED.txt";
/** All files of one message are fetched within this. */
const messageBudgetMs = 60_000;
/** The checks of whether the task agent may stay on the web, all of them. */
const relayBudgetMs = 20_000;
/** Where Bro's staged files live; a mention of it may still name none. */
const attachmentsRoot = "/workspace/attachments/";
const notSent = "Бро не передал этот файл";
/**
 * An object older than `inboxFreshMs`: no turn of the person's named it to
 * the task agent just now, so it is not taken. Only the person's next
 * message can send it again (Bro's hook copies in their turns alone), so
 * the reason asks Bro for that, not for another `task` call.
 */
const sentEarlier =
  "файл передан не с сообщением человека — Бро, попроси человека повторить просьбу или прислать файл ещё раз";
const notOffline =
  "песочницу не удалось отключить от интернета, поэтому файл не передан";
/** What a steered message's file waits for: Bro's hook storing it now. */
const notYetStored: ReadonlySet<string> = new Set([notSent, sentEarlier]);
/**
 * The pauses before the inbox is asked again for a file of a message Bro
 * steered in: about Bro's own step budget for copying (`task-files.ts`).
 */
const steeredRetryMs = [1000, 2000, 4000, 8000, 8000] as const;

/**
 * The turn of the last message seen. A new task or a continuation of an
 * idle one opens a turn of its own, and eve starts it only once Bro's step,
 * its copying included, is over (`acknowledgeDelegatedTasksStep`). A
 * message into the turn already running is Bro steering the busy task
 * agent: eve hands it over from inside `task`'s execute, while Bro's hook
 * may still be copying (`execution/tools/subagent/steer.js`).
 */
const lastMessage = defineState<{
  readonly sequence: number | null;
  readonly turnId: string | null;
}>("bro.task-files-message", () => ({ sequence: null, turnId: null }));

/** Whether the message came into a turn that already had one. */
function steeredIn(data: {
  readonly sequence: number;
  readonly turnId: string;
}) {
  try {
    let steered = false;
    lastMessage.update((last) => {
      steered = last.turnId === data.turnId && last.sequence === data.sequence;
      return { sequence: data.sequence, turnId: data.turnId };
    });
    return steered;
  } catch {
    return false;
  }
}

/**
 * The person's files in the task agent's sandbox (docs/roadmap.md, item
 * 30): each staged path in Bro's message is fetched from the
 * conversation's inbox, where Bro's hook put it (`agent/hooks/task-files.ts`),
 * and written at the same path, so the path Bro wrote is the file. The
 * first message reaches this as eve's "Caller message:" prompt and a
 * continuation as Bro's text; either names the paths. Only a file stored
 * within the last minutes is taken: Bro's hook stores it whenever the
 * person's turn names it, so an older one is a later, not the person's,
 * turn naming it again. Before the first file goes in, the sandbox and its
 * conversation are marked as holding the person's files, and the tool
 * router keeps the sandbox off the web from then on
 * (`agent/lib/sandbox/router.ts`); no mark, no file. Every message, files
 * or not, first goes through `keepOffWebUnlessSent`: in a conversation so
 * marked, a task agent the person's own turn did not just start goes off
 * the web too.
 *
 * `message.received` is part of the turn's preamble: eve emits it inside
 * the step's context scope, where the sandbox provider is bound and opens
 * the sandbox on first use (`context/run-step.js`,
 * `context/providers/sandbox.js`), and awaits the hook before the turn's
 * first model call. A file already there as its path names it stays; one
 * the task agent changed is never overwritten. A file of a steered message
 * that is not there yet is asked for again for a while (`steeredIn`). What
 * did not arrive is listed in NOT_RECEIVED.txt, rewritten for each message
 * that mentions the files, and the list goes once everything did. Nothing
 * fails the task.
 */
export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      try {
        const { parent } = ctx.session;
        if (parent === undefined || !taskFilesOfCaller(ctx)) return;
        const { message } = event.data;
        const steered = steeredIn(event.data);
        const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
        if (caller === null) return;
        const { workspaceId } = scopeFromPrincipal(caller);
        const conversation = {
          parentSessionId: parent.sessionId,
          workspaceId,
        };
        const sandbox = once(async () => await ctx.getSandbox());
        const relay = await keepOffWebUnlessSent({
          ...conversation,
          callId: parent.callId,
          sandbox,
          steered,
        });
        const named = namedAttachmentPaths(message);
        const mentioned = message
          .replaceAll(notReceivedPath, "")
          .includes(attachmentsRoot);
        if (named.length === 0 && !mentioned) {
          if (relay !== "online") console.info("[task-files] relay", { relay });
          return;
        }
        const open = await sandbox();
        const marked = relay === "offline" || relay === "taken-offline";
        const missing = await receive({
          offline: once(async (signal?: AbortSignal) => {
            if (marked) return;
            await markSandboxHoldsPersonFiles(
              { ...conversation, sandboxId: open.id },
              signal
            );
          }),
          paths: named.slice(0, attachmentsPerMessage),
          sandbox: open,
          sessionId: parent.sessionId,
          steered,
          workspaceId,
        });
        if (named.length === 0) {
          // A path Bro miswrote: the old list must not stand for this one.
          missing.push({
            path: `${attachmentsRoot}…`,
            reason: "путь в сообщении Бро не похож на переданный файл",
          });
        }
        for (const path of named.slice(attachmentsPerMessage)) {
          missing.push({ path, reason: "больше 10 файлов в одном сообщении" });
        }
        await (missing.length === 0
          ? open.removePath({ force: true, path: notReceivedPath })
          : open.writeTextFile({
              content: notReceivedText(missing),
              path: notReceivedPath,
            }));
        console.info("[task-files] received", {
          missing: missing.length,
          named: named.length,
          relay,
        });
      } catch (error) {
        console.warn("[task-files] files not received", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    },
  },
});

type Sandbox = Awaited<ReturnType<HookContext["getSandbox"]>>;

/** The first call's promise, for every call: one mark, one sandbox a message. */
function once<T>(run: (signal?: AbortSignal) => Promise<T>) {
  let started: Promise<T> | undefined;
  return async (signal?: AbortSignal) => {
    started ??= run(signal);
    return await started;
  };
}

/**
 * Keeps the task agent off the web when its conversation already gave
 * another task agent the person's files and this message did not come from
 * the person's own turn. Such a task agent's report comes back to Bro as a
 * turn of its own (`[Task state]`), and an instruction hidden in a file can
 * have it ask Bro to pass the file's content on to a new helper, which
 * would send it out in a URL: the files' mark is per sandbox, text is not.
 * So a task agent of such a conversation stays on the web only when the
 * person's turn made the very `task` call that started it, within the last
 * minutes (`personCallFresh`, stored by Bro's hook); a message steered into
 * a busy one, a continuation the `task` call of which was not the person's
 * just now, and every check that fails take it off for good. A mark that
 * cannot be written is owed (`recordOfflineOwed`), and the task agent's
 * model refuses its steps until a later message writes it.
 */
async function keepOffWebUnlessSent(input: {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly sandbox: () => Promise<Sandbox>;
  readonly steered: boolean;
  readonly workspaceId: string;
}) {
  const signal = AbortSignal.timeout(relayBudgetMs);
  const { callId, parentSessionId, workspaceId } = input;
  const owed = offlineOwed();
  const held =
    owed ||
    (await conversationHoldsPersonFiles(
      workspaceId,
      parentSessionId,
      signal
    ).catch(() => true));
  if (!held) return "online" as const;
  const sandbox = await input.sandbox();
  const marked =
    !owed &&
    (await sandboxHoldsPersonFiles(sandbox.id, signal).catch(() => false));
  if (marked) return "offline" as const;
  const sent =
    !owed &&
    !input.steered &&
    (await personCallFresh(workspaceId, parentSessionId, callId, signal).catch(
      () => false
    ));
  if (sent) return "online" as const;
  try {
    await markSandboxHoldsPersonFiles(
      { parentSessionId, sandboxId: sandbox.id, workspaceId },
      signal
    );
    if (owed) recordOfflineOwed(false);
    return "taken-offline" as const;
  } catch {
    recordOfflineOwed(true);
    return "owed" as const;
  }
}

/**
 * Puts each file in place; the ones that did not arrive, and why, in the
 * order Bro named them. A steered message's files Bro did not send yet are
 * asked for again after each pause.
 */
async function receive(input: {
  /** Marks the sandbox as holding the person's files; throws when it could not. */
  readonly offline: (signal?: AbortSignal) => Promise<void>;
  readonly paths: readonly string[];
  readonly sandbox: Sandbox;
  readonly sessionId: string;
  readonly steered: boolean;
  readonly workspaceId: string;
}) {
  const deadline = AbortSignal.timeout(messageBudgetMs);
  const reasons = new Map<string, string | undefined>();
  const pass = async (paths: readonly string[]) => {
    for (const path of paths) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One file at a time, within the message's budget.
      const reason = await receiveOne(input, path, deadline).catch(
        () => "не удалось получить файл"
      );
      reasons.set(path, reason);
    }
  };
  await pass(input.paths);
  for (const pauseMs of input.steered ? steeredRetryMs : []) {
    const unsent = input.paths.filter((path) =>
      notYetStored.has(reasons.get(path) ?? "")
    );
    if (unsent.length === 0 || deadline.aborted) break;
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each round waits for Bro's copying.
    if (!(await pause(pauseMs, deadline))) break;
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    await pass(unsent);
  }
  return input.paths.flatMap((path) => {
    const reason = reasons.get(path);
    return reason === undefined ? [] : [{ path, reason }];
  });
}

/** Whether the pause ran out before the deadline did. */
async function pause(ms: number, signal: AbortSignal) {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Undefined once the file is in place, else why it is not. */
async function receiveOne(
  input: Parameters<typeof receive>[0],
  path: string,
  signal: AbortSignal
) {
  // Already here: copied for an earlier message, or worked on since.
  if (await sandboxHasFile(input.sandbox, path, signal)) return undefined;
  const stored = await getInbox(
    inboxKey(input.workspaceId, input.sessionId, path),
    signal
  );
  if (stored.kind === "missing") return notSent;
  if (stored.kind === "stale") return sentEarlier;
  if (!pathMatchesBytes(path, stored.bytes)) return "файл пришёл повреждённым";
  try {
    await input.offline(signal);
  } catch {
    return notOffline;
  }
  await input.sandbox.writeBinaryFile({
    abortSignal: signal,
    content: stored.bytes,
    path,
  });
  return undefined;
}

/** One line a file, in the order Bro named them. */
function notReceivedText(
  missing: readonly { readonly path: string; readonly reason: string }[]
) {
  return `${[
    "Не дошли файлы из последнего сообщения Бро, где он назвал файлы:",
    ...missing.map(({ path, reason }) => `${path} — ${reason}`),
  ].join("\n")}\n`;
}
