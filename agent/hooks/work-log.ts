import { defineHook, type HookContext } from "eve/hooks";
import { appendWorkLine, workLineLimit } from "@db/services/work-log";
import { spokenWords } from "@agent/lib/browser-use/said";
import { recapChannels } from "@agent/lib/conversation/recap";
import { withoutLocationLines } from "@agent/lib/location/note";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { withoutSecrets } from "@agent/lib/privacy/secrets";
import { workLogEnabled } from "@agent/lib/work-log/pilot";
import { isBackgroundTurnText } from "@shared/chat/background-turn";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";

/**
 * What Bro did in a chat, into `work_log` for the chats that come after it
 * (`agent/lib/work-log/`): /talk's voice opens a new chat each time, and on
 * 28.10 it knew nothing of a contract, a quarter's figures or a letter Bro
 * had made in another chat twenty minutes before (0 of 14 such questions
 * answered). Only for the pilot (WORK_LOG_WORKSPACES), only the web chat,
 * Telegram and iMessage. The person's lines are the messages of turns they
 * started, with the names of the files they sent; Bro's are every message
 * it delivered there, the report of work it handed off included. Links,
 * one-time codes, card numbers and passwords are cut out first
 * (`withoutSecrets`). A failed write costs the line, never the turn.
 */
export default defineHook({
  events: {
    async "message.received"(event, ctx) {
      if (event.data.kind !== undefined) return;
      if (isBackgroundTurnText(event.data.message)) return;
      if (!startedByPerson(ctx)) return;
      const files = (event.data.parts ?? []).flatMap((part) =>
        part.type === "file" && part.filename !== undefined
          ? [part.filename]
          : []
      );
      // A shared location's context line names where the person was; from
      // /talk, the voice marker and the voice's own lines are no request.
      const words = spokenWords(withoutLocationLines(event.data.message));
      const said = (
        files.length > 0 ? words.replaceAll(fileNotes, "") : words
      ).trim();
      const text = said === "" ? files.join(", ") : said;
      await keep(ctx, event, "person", text, files);
    },
    async "action.result"(event, ctx) {
      // What reached the person: a refused or stale send is not Bro's word.
      if (event.data.status !== "completed") return;
      const result = sendMessageToolResultSchema.safeParse(event.data.result);
      if (!result.success) return;
      const output = result.data.output;
      // A link alone names nothing done.
      if (output.kind === "link" || output.text === undefined) return;
      const text = output.text;
      await keep(ctx, event, "bro", text, []);
    },
  },
});

const fileNameLimit = 200;

/**
 * The notes eve or a channel writes into the message for a file it carries
 * (`[file: name (type)]`, `[файл: …]`, `Attached file …`): the line keeps
 * the names apart, and on 28.10 the notes took half of the voice brief's
 * room for a request.
 */
const fileNotes =
  /\[(?:file|файл):[^\]\n]*\]|^Attached file .*$|^Attachment .* could not be retrieved: .*$/gmu;

/**
 * A line without its links, their words kept: a link of Bro's own (a card,
 * a payment page, a shared file) opens for whoever holds it, and none of
 * them is worth its tokens in the voice's brief.
 */
function withoutLinks(text: string) {
  return text
    .replaceAll(/\[([^\]\n]*)\]\([^)\s]*\)/gu, "$1")
    .replaceAll(/https?:\/\/\S+/giu, "[ссылка]");
}

async function keep(
  ctx: HookContext,
  event: {
    readonly data: { readonly turnId: string };
    readonly meta: { readonly at: string };
  },
  role: "bro" | "person",
  text: string,
  files: readonly string[]
) {
  // A subagent inherits its parent's caller but is not where anyone talks.
  if (ctx.session.parent) return;
  const channel = ctx.channel.kind;
  if (channel === undefined || !recapChannels.has(channel)) return;
  const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
  if (!caller) return;
  try {
    const scope = scopeFromPrincipal(caller);
    if (!workLogEnabled(scope.workspaceId)) return;
    await appendWorkLine(scope.workspaceId, {
      channel,
      createdAt: new Date(event.meta.at),
      files: files
        .slice(0, 10)
        .map((name) => withoutSecrets(name, fileNameLimit)),
      role,
      sessionId: ctx.session.id,
      text: withoutSecrets(withoutLinks(text), workLineLimit),
      turnId: event.data.turnId,
    });
  } catch (error) {
    // The error of a failed insert quotes its parameters, the line among
    // them: only its name is logged.
    console.warn("[work-log] a line was not kept", {
      cause: error instanceof Error ? error.name : "unknown",
      sessionId: ctx.session.id,
    });
  }
}
