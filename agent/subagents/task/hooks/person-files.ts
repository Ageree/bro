import { createHash } from "node:crypto";
import { defineState, type SessionParent } from "eve/context";
import { defineHook, type HookContext } from "eve/hooks";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  attachmentsPerMessage,
  conversationHoldsPersonFiles,
  getInbox,
  getPersonRequest,
  inboxKey,
  markSandboxHoldsPersonFiles,
  markSandboxOffWeb,
  namedAttachmentPaths,
  pathMatchesBytes,
  type PersonSend,
  sandboxHasFile,
  sandboxHoldsPersonFiles,
  takePersonSend,
} from "@agent/lib/sandbox/inbox";
import {
  offlineRefusal,
  recordOfflineRefusal,
} from "@agent/lib/sandbox/offline";
import { taskFilesGuarded, taskFilesOfCaller } from "@agent/lib/sandbox/pilot";
import { taskAgentTool } from "@agent/lib/turn-kind/sets";

/** What the task agent reads when a file Bro named is not there. */
const notReceivedPath = "/workspace/attachments/NOT_RECEIVED.txt";
/** The person's own words of the turn that sent this message, verbatim. */
const requestPath = "/workspace/attachments/REQUEST.txt";
/** Fetching the person's words and putting them in place. */
const requestBudgetMs = 10_000;
/**
 * The pauses before the words of a message Bro steered in are asked for
 * again: Bro's hook stores them as the call streams in, while eve hands
 * the message over, and a steered message from a turn that was not the
 * person's, which brings none, waits them all out.
 */
const steeredRequestRetryMs = [250, 500, 1000] as const;
/** All files of one message are fetched within this, a few at a time. */
const messageBudgetMs = 120_000;
/** How many files are fetched and written at once, which bounds the memory. */
const copiesAtOnce = 3;
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

/**
 * How the message came: the task agent's first, which the call that started
 * it brought; one that opens a later turn, a continuation; one into a turn
 * that already had one, steered. Undefined when the record cannot be read.
 */
function arrivalOf(data: {
  readonly sequence: number;
  readonly turnId: string;
}) {
  try {
    const last = lastMessage.get();
    lastMessage.update(() => ({
      sequence: data.sequence,
      turnId: data.turnId,
    }));
    if (last.turnId === null) return "first" as const;
    return last.turnId === data.turnId && last.sequence === data.sequence
      ? ("steered" as const)
      : ("continued" as const);
  } catch {
    return undefined;
  }
}

/**
 * The `agentId` Bro's `task` continues this task agent by: eve derives it
 * from the call that started it, `ag_<name>:` and 12 hex of the sha256 of
 * Bro's session, turn and call ids (`mintStartOperation` in
 * `execution/dispatch-start-operation.js`), the very lineage
 * `ctx.session.parent` keeps. Should eve derive it otherwise, no record of
 * the person's matches, and the continuation only loses the web.
 */
function ownAgentId(parent: SessionParent) {
  const operation = createHash("sha256")
    .update(`${parent.sessionId}\0${parent.turn.id}\0${parent.callId}`)
    .digest("hex");
  return `ag_${taskAgentTool}:${operation.slice(0, 12)}`;
}

/** Where eve's first message to a subagent puts Bro's own text. */
const callerMessageHeading = "\nCaller message:\n";

/**
 * Bro's own text in the task agent's first message: eve wraps it in a
 * preamble that ends with "Caller message:" (`formatSubagentPrompt` in
 * `subagents/invocation.js`), and Bro's hook records the call's text
 * itself. A message without that heading is taken whole, and then matches
 * no record of the person's: the task agent only loses the web.
 */
function callerMessage(message: string) {
  const at = message.indexOf(callerMessageHeading);
  return at === -1 ? message : message.slice(at + callerMessageHeading.length);
}

/**
 * The person's send this message would be: the starting call and its turn
 * for the first message, the task agent's `agentId` for a continuation,
 * since `ctx.session.parent` stays the starting call's for good; either
 * with the text Bro sent. None for a steered message, which eve hands over
 * from inside `task` while Bro's hook may still be recording it, or for one
 * whose arrival is unknown.
 */
function sendOf(
  arrival: ReturnType<typeof arrivalOf>,
  parent: SessionParent,
  message: string
): PersonSend | undefined {
  if (arrival === "first") {
    return {
      callId: parent.callId,
      kind: "start",
      message: callerMessage(message),
      turnId: parent.turn.id,
    };
  }
  if (arrival === "continued") {
    return { agentId: ownAgentId(parent), kind: "continue", message };
  }
  return undefined;
}

/**
 * The send whose words this message comes with: {@link sendOf}'s, and for a
 * steered message the continuation Bro's `task` call names. The words only
 * tell the task agent what the person said, so a steered message may bring
 * them, though it never keeps the web.
 */
function requestSendOf(
  arrival: ReturnType<typeof arrivalOf>,
  parent: SessionParent,
  message: string
): PersonSend | undefined {
  if (arrival === "steered") {
    return { agentId: ownAgentId(parent), kind: "continue", message };
  }
  return sendOf(arrival, parent, message);
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
 * marked, a task agent goes off the web too unless the person's own turn
 * just sent it this message. That check runs wherever Object Storage is,
 * the files pilot on or not (`taskFilesGuarded`): a conversation marked
 * while TASK_FILES_WORKSPACES named its workspace keeps the files' content
 * in Bro's history after the flag is cleared. Only the files themselves,
 * NOT_RECEIVED.txt and REQUEST.txt, the person's own words of the turn that
 * sent the message, for a sandbox off the web alone (`deliverRequest`),
 * follow the flag.
 *
 * `message.received` is part of the turn's preamble: eve emits it inside
 * the step's context scope, where the sandbox provider is bound and opens
 * the sandbox on first use (`context/run-step.js`,
 * `context/providers/sandbox.js`), and awaits the hook before the turn's
 * first model call. A file already there as its path names it stays; one
 * the task agent changed is never overwritten. A file of a steered message
 * that is not there yet is asked for again for a while (`arrivalOf`). What
 * did not arrive is listed in NOT_RECEIVED.txt, rewritten for each message
 * that mentions the files, and the list goes once everything did. Nothing
 * fails the task.
 */
export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      try {
        const { parent } = ctx.session;
        if (parent === undefined || !taskFilesGuarded()) return;
        const { message } = event.data;
        const arrival = arrivalOf(event.data);
        const steered = arrival === "steered";
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
          sandbox,
          send: sendOf(arrival, parent, message),
          taker: JSON.stringify([
            ctx.session.id,
            event.data.turnId,
            event.data.sequence,
          ]),
        });
        if (!taskFilesOfCaller(ctx)) {
          if (relay !== "online") console.info("[task-files] relay", { relay });
          return;
        }
        // The words are read while the files come, and go in only once the
        // files settled whether the sandbox is off the web. A helper on the
        // web that no file can take off it is not asked for them at all.
        const offWebAlready = relay === "offline" || relay === "taken-offline";
        const words =
          offWebAlready || namedAttachmentPaths(message).length > 0
            ? personWords({
                ...conversation,
                arrival,
                send: requestSendOf(arrival, parent, message),
              }).catch(() => undefined)
            : Promise.resolve(undefined);
        let filesTookOffWeb = false;
        try {
          filesTookOffWeb = await receiveFiles({
            ...conversation,
            message,
            relay,
            sandbox,
            steered,
          });
        } finally {
          const request = await deliverRequest({
            arrival,
            offWeb: offWebAlready || filesTookOffWeb,
            sandbox,
            words: await words,
          }).catch(() => "failed" as const);
          if (request !== "none") {
            console.info("[task-files] request", { request });
          }
        }
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
 * have it ask Bro to pass the file's content on to a helper, new or
 * continued, which would send it out in a URL: the files' mark is per
 * sandbox, text is not. So a task agent of such a conversation stays on the
 * web only when the person's turn sent this very text within the last
 * minutes (`takePersonSend`, stored by Bro's hook): the `task` call that
 * started it, in its turn, or, for a continuation, a `task` call naming its
 * `agentId`. The record is claimed by the message that takes it, so the
 * same text sent again by a report's turn finds it taken, while this very
 * message, its step run again from the state before it, finds its own
 * claim. A
 * steered message and a continuation the person did not just send take it
 * off for good, its sandbox alone (`markSandboxOffWeb`): only a file going
 * in marks the conversation. A check that cannot be read marks nothing on a
 * guess: the task agent's model refuses this message's steps
 * (`recordOfflineRefusal`), and the next message checks again. A mark that
 * cannot be written is owed, and the model refuses until a later message
 * writes it.
 */
async function keepOffWebUnlessSent(input: {
  readonly parentSessionId: string;
  readonly sandbox: () => Promise<Sandbox>;
  /** The person's send this message would be; none for a steered one. */
  readonly send: PersonSend | undefined;
  /** This very message of the task agent's, as it claims the send. */
  readonly taker: string;
  readonly workspaceId: string;
}) {
  const signal = AbortSignal.timeout(relayBudgetMs);
  const { parentSessionId, send, taker, workspaceId } = input;
  const owed = offlineRefusal() === "owed";
  const held =
    owed ||
    (await conversationHoldsPersonFiles(
      workspaceId,
      parentSessionId,
      signal
    ).catch(() => undefined));
  if (held === false) {
    settle();
    return "online" as const;
  }
  const sandbox = await input.sandbox();
  // An unreadable mark is checked by the router itself, which then refuses.
  const marked =
    !owed &&
    (await sandboxHoldsPersonFiles(sandbox.id, signal).catch(() => false));
  if (marked) {
    settle();
    return "offline" as const;
  }
  const sent =
    owed || send === undefined
      ? false
      : await takePersonSend(
          workspaceId,
          parentSessionId,
          send,
          taker,
          signal
        ).catch(() => undefined);
  if (sent === true) {
    settle();
    return "online" as const;
  }
  if (held === undefined || sent === undefined) {
    recordOfflineRefusal("unchecked");
    return "unchecked" as const;
  }
  try {
    await markSandboxOffWeb(sandbox.id, signal);
    settle();
    return "taken-offline" as const;
  } catch {
    recordOfflineRefusal("owed");
    return "owed" as const;
  }
}

/**
 * The files Bro's message names, put in place, and the list of the ones that
 * did not arrive; a message that names none and mentions no attachment
 * leaves everything as it was. Whether a file of this message took the
 * sandbox off the web: its mark went in.
 */
async function receiveFiles(input: {
  readonly message: string;
  readonly parentSessionId: string;
  readonly relay: Awaited<ReturnType<typeof keepOffWebUnlessSent>>;
  readonly sandbox: () => Promise<Sandbox>;
  readonly steered: boolean;
  readonly workspaceId: string;
}) {
  const { message, parentSessionId, relay, sandbox, steered, workspaceId } =
    input;
  const conversation = { parentSessionId, workspaceId };
  const named = namedAttachmentPaths(message);
  const mentioned = message
    .replaceAll(notReceivedPath, "")
    .replaceAll(requestPath, "")
    .includes(attachmentsRoot);
  if (named.length === 0 && !mentioned) {
    if (relay !== "online") console.info("[task-files] relay", { relay });
    return false;
  }
  const open = await sandbox();
  const marked = relay === "offline" || relay === "taken-offline";
  let markedNow = false;
  const missing = await receive({
    offline: once(async (signal?: AbortSignal) => {
      if (marked) return;
      await markSandboxHoldsPersonFiles(
        { ...conversation, sandboxId: open.id },
        signal
      );
      markedNow = true;
      // Off the web now, whatever this message's checks left owed.
      settle();
    }),
    paths: named.slice(0, attachmentsPerMessage),
    sandbox: open,
    sessionId: parentSessionId,
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
    missing.push({
      path,
      reason: `больше ${String(attachmentsPerMessage)} файлов в одном сообщении`,
    });
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
  return markedNow;
}

/** Lifts the refusal an earlier message left: this one settled the web. */
function settle() {
  if (offlineRefusal() !== "none") recordOfflineRefusal("none");
}

/**
 * The person's own words of the turn that sent this message, as Bro's hook
 * stored them beside the `task` call (`putPersonRequest`): Bro's message
 * retells them and may drop a condition. Only words stored within the last
 * minutes are taken, so a turn that was not the person's, sending the same
 * text later, brings none. A steered message's are asked for again for a
 * second or two: Bro's hook may still be storing them. Undefined when there
 * are none or they cannot be read.
 */
async function personWords(input: {
  readonly arrival: ReturnType<typeof arrivalOf>;
  readonly parentSessionId: string;
  readonly send: PersonSend | undefined;
  readonly workspaceId: string;
}) {
  const { arrival, send } = input;
  if (send === undefined) return undefined;
  const signal = AbortSignal.timeout(requestBudgetMs);
  const pauses = arrival === "steered" ? steeredRequestRetryMs : [];
  for (const pauseMs of [0, ...pauses]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each round waits for Bro's hook.
    if (pauseMs > 0 && !(await pause(pauseMs, signal))) break;
    // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
    const stored = await getPersonRequest(
      input.workspaceId,
      input.parentSessionId,
      send,
      signal
    ).catch(() => undefined);
    if (stored?.kind === "words") return stored.words;
  }
  return undefined;
}

/**
 * Puts the person's words in REQUEST.txt, only in a sandbox off the web:
 * this message's files took it off, or the conversation's checks did. The
 * words are the person's verbatim, what they named and asked included, and
 * a helper on the web, which a page's instruction can lead to send them out
 * in a URL, works from Bro's retelling alone. Its sandbox is not even
 * opened, which may cost a snapshot's restore or a wait for room on the
 * host: it holds no REQUEST.txt, since a sandbox once off the web stays so.
 * Each message's words replace the last. A continuation without any (a
 * report's turn sent it) takes the old ones away: they asked for the task
 * before, not for this. A steered message joins the task the words already
 * there asked for, so it only replaces them. A failure is the caller's to
 * log, and costs the files nothing.
 */
async function deliverRequest(input: {
  readonly arrival: ReturnType<typeof arrivalOf>;
  readonly offWeb: boolean;
  readonly sandbox: () => Promise<Sandbox>;
  readonly words: string | undefined;
}) {
  const { arrival, offWeb, words } = input;
  if (!offWeb) {
    return words === undefined ? ("none" as const) : ("withheld" as const);
  }
  if (words !== undefined) {
    const open = await input.sandbox();
    await open.writeTextFile({
      content: words.endsWith("\n") ? words : `${words}\n`,
      path: requestPath,
    });
    return "written" as const;
  }
  // A new task agent's sandbox has no words yet; a steered message keeps them.
  if (arrival !== "continued") return "none" as const;
  const open = await input.sandbox();
  await open.removePath({ force: true, path: requestPath });
  return "removed" as const;
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
  // Each file's write waits for the sandbox's mark (`input.offline`, one
  // promise for all of them), so the mark still goes in before any file.
  const pass = async (paths: readonly string[]) => {
    for (let start = 0; start < paths.length; start += copiesAtOnce) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one shared deadline, 3 at a time
      await Promise.all(
        paths.slice(start, start + copiesAtOnce).map(async (path) => {
          const reason = await receiveOne(input, path, deadline).catch(
            () => "не удалось получить файл"
          );
          reasons.set(path, reason);
        })
      );
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
