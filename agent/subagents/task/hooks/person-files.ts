import { defineHook, type HookContext } from "eve/hooks";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  attachmentsPerMessage,
  getInbox,
  inboxKey,
  namedAttachmentPaths,
  pathMatchesBytes,
} from "@agent/lib/sandbox/inbox";
import { taskFilesOfCaller } from "@agent/lib/sandbox/pilot";

/** What the task agent reads when a file Bro named is not there. */
const notReceivedPath = "/workspace/attachments/NOT_RECEIVED.txt";
/** All files of one message are fetched within this. */
const messageBudgetMs = 60_000;

/**
 * The person's files in the task agent's sandbox (docs/roadmap.md, item
 * 30): each staged path in Bro's message is fetched from the
 * conversation's inbox, where Bro's hook put it (`agent/hooks/task-files.ts`),
 * and written at the same path, so the path Bro wrote is the file. The
 * first message reaches this as eve's "Caller message:" prompt and a
 * continuation as Bro's text; either names the paths.
 *
 * `message.received` is part of the turn's preamble: eve emits it inside
 * the step's context scope, where the sandbox provider is bound and opens
 * the sandbox on first use (`context/run-step.js`,
 * `context/providers/sandbox.js`), and awaits the hook before the turn's
 * first model call. A file already there as its path names it stays; one
 * the task agent changed is never overwritten. What did not arrive is
 * listed in NOT_RECEIVED.txt, and the list goes once everything did.
 * Nothing fails the task.
 */
export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      try {
        const { parent } = ctx.session;
        if (parent === undefined || !taskFilesOfCaller(ctx)) return;
        const named = namedAttachmentPaths(event.data.message);
        if (named.length === 0) return;
        const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
        if (caller === null) return;
        const { workspaceId } = scopeFromPrincipal(caller);
        const sandbox = await ctx.getSandbox();
        const missing = await receive({
          paths: named.slice(0, attachmentsPerMessage),
          sandbox,
          sessionId: parent.sessionId,
          workspaceId,
        });
        for (const path of named.slice(attachmentsPerMessage)) {
          missing.push({ path, reason: "больше 10 файлов в одном сообщении" });
        }
        await (missing.length === 0
          ? sandbox.removePath({ force: true, path: notReceivedPath })
          : sandbox.writeTextFile({
              content: notReceivedText(missing),
              path: notReceivedPath,
            }));
        console.info("[task-files] received", {
          missing: missing.length,
          named: named.length,
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

/** Puts each file in place; the ones that did not arrive, and why. */
async function receive(input: {
  readonly paths: readonly string[];
  readonly sandbox: Sandbox;
  readonly sessionId: string;
  readonly workspaceId: string;
}) {
  const deadline = AbortSignal.timeout(messageBudgetMs);
  const missing: { path: string; reason: string }[] = [];
  for (const path of input.paths) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- One file at a time, within the message's budget.
    const reason = await receiveOne(input, path, deadline).catch(
      () => "не удалось получить файл"
    );
    if (reason !== undefined) missing.push({ path, reason });
  }
  return missing;
}

/** Undefined once the file is in place, else why it is not. */
async function receiveOne(
  input: Parameters<typeof receive>[0],
  path: string,
  signal: AbortSignal
) {
  // Already here: copied for an earlier message, or worked on since.
  const present = await input.sandbox.readBinaryFile({
    abortSignal: signal,
    path,
  });
  if (present !== null) return undefined;
  const bytes = await getInbox(
    inboxKey(input.workspaceId, input.sessionId, path),
    signal
  );
  if (bytes === null) return "Бро не передал этот файл";
  if (!pathMatchesBytes(path, bytes)) return "файл пришёл повреждённым";
  await input.sandbox.writeBinaryFile({
    abortSignal: signal,
    content: bytes,
    path,
  });
  return undefined;
}

/** One line a file, in the order Bro named them. */
function notReceivedText(
  missing: readonly { readonly path: string; readonly reason: string }[]
) {
  return `${[
    "Эти файлы из последнего сообщения Бро не дошли:",
    ...missing.map(({ path, reason }) => `${path} — ${reason}`),
  ].join("\n")}\n`;
}
