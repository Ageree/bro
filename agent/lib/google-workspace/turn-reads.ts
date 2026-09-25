import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { currentTurnMessages } from "@agent/lib/delivery/turn-sends";
import { googleRateLimitMessage } from "./client";
import { driveReadInputSchema, driveSearchInputSchema } from "./drive";
import {
  gmailReadThreadInputSchema,
  gmailSearchInputSchema,
  gmailUpdateInputSchema,
} from "./gmail";

/**
 * Google reads one turn may make. A benchmark turn made 198 tool calls, 40
 * of them the same `gmail-search`, and the run as a whole collected 293
 * quota errors; nothing a person asks for in one message needs more reads.
 * A background worker triaging a whole inbox on schedule gets more room.
 *
 * Searches that found nothing have a budget of their own: asked to sort out
 * «счёт от репетитора», a turn ran 25 Gmail searches with ever new words,
 * nearly all of them empty. Past a handful, another guess at the words will
 * not find it either; the sender or the date from the person will.
 */
export const turnReadLimits = {
  background: { emptySearches: 15, reads: 60 },
  interactive: { emptySearches: 6, reads: 20 },
} as const;

type TurnReadLimits = (typeof turnReadLimits)[keyof typeof turnReadLimits];

/**
 * Google writes after which what the turn read may no longer be what the
 * mailbox holds: a search repeated after archiving must reach Google, and a
 * calendar change mails invitations or cancellations.
 */
const googleWriteTools = new Set([
  "calendar-create-event",
  "calendar-delete-event",
  "calendar-update-event",
  "gmail-draft",
  "gmail-send",
  "gmail-update",
]);

/**
 * An `apps` call that could change a Google file: a `run` on the person's
 * Google connection. Searches and other apps never touch Google.
 */
const googleAppsRunSchema = z.object({
  input: z.object({ action: z.literal("run"), app: z.literal("google") }),
  toolName: z.literal("apps"),
});

/**
 * An `apps` result that changed something: a Sheets or Docs edit changes
 * what drive-read returns. A read, a refusal or a failure changes nothing.
 */
const appsWroteSchema = z.object({
  status: z.literal("done"),
  wrote: z.literal(true),
});

function appsWrote(output: ToolResultPart["output"]) {
  return (
    output.type === "json" && appsWroteSchema.safeParse(output.value).success
  );
}

/**
 * Reads a turn may have refused before it is ended. The model gets told it
 * already has a result; a model that keeps asking anyway is looping.
 */
const refusalsBeforeEnd = 3;

/** A guarded read as the model called it, parsed from a tool call. */
const googleReadCallSchema = z.discriminatedUnion("toolName", [
  z.object({
    input: gmailSearchInputSchema,
    toolName: z.literal("gmail-search"),
  }),
  z.object({
    input: gmailReadThreadInputSchema,
    toolName: z.literal("gmail-read-thread"),
  }),
  z.object({
    input: driveSearchInputSchema,
    toolName: z.literal("drive-search"),
  }),
  z.object({
    input: driveReadInputSchema,
    toolName: z.literal("drive-read"),
  }),
]);

type GoogleReadCall = z.infer<typeof googleReadCallSchema>;

/**
 * Identifies one guarded read by what it asks Google for, so the same search
 * is recognised whether or not the model spelled out a default.
 */
export function googleReadKey(call: GoogleReadCall) {
  const target =
    call.toolName === "gmail-search"
      ? `${String(call.input.maxResults)}\u0000${call.input.query.trim()}`
      : call.toolName === "drive-search"
        ? `${String(call.input.maxResults)}\u0000${call.input.kind ?? ""}\u0000${call.input.query ?? ""}`
        : call.toolName === "gmail-read-thread"
          ? call.input.threadId.trim()
          : call.input.fileId;
  return `${call.toolName}\u0000${target}`;
}

/** What the current turn's guarded reads did so far. */
export interface TurnReads {
  /** Reads that reached Google, successful or not. */
  readonly count: number;
  /** Reads this turn may make before the guard refuses more. */
  readonly limit: number;
  /** Searches this turn ran that found nothing. */
  readonly emptySearches: number;
  /** Empty searches after which the guard refuses another search. */
  readonly emptySearchLimit: number;
  /** Keys of reads that returned a result the model already holds. */
  readonly done: readonly string[];
  /** Whether a read this turn ended in Google's rate or quota refusal. */
  readonly rateLimited: boolean;
  /** Reads refused by this guard. */
  readonly refused: number;
}

export type RefusalReason =
  | "duplicate"
  | "empty_searches"
  | "limit"
  | "rate_limited";

const refusedPrefix = "Not run:";

const refusalNotices = {
  duplicate: `${refusedPrefix} this exact call already ran in this turn and its result is above. Use that result instead of calling again; if you need something else, change the query.`,
  empty_searches: `${refusedPrefix} this turn already ran several searches that found nothing, and guessing more words will not find it either. Stop searching now: tell the person plainly that you did not find it, and ask one short question that would — who sent it, roughly when it came, or what the subject or the file was called.`,
  limit: `${refusedPrefix} this turn already made the most Google reads one reply may take. Stop reading and answer the person with what you have.`,
  rate_limited: `${refusedPrefix} ${googleRateLimitMessage}`,
} as const satisfies Record<RefusalReason, string>;

/** The tool result the model reads for a refused read. */
export function readRefusalNotice(reason: RefusalReason) {
  return refusalNotices[reason];
}

/** Whether a tool result is this guard's refusal. */
function isRefusal(output: ToolResultPart["output"]) {
  return output.type === "text" && output.value.startsWith(refusedPrefix);
}

function succeeded(output: ToolResultPart["output"]) {
  return !output.type.startsWith("error") && output.type !== "execution-denied";
}

/** The reads whose result is a list that can come back empty. */
const searchTools = new Set(["drive-search", "gmail-search"]);

function isSearchKey(key: string) {
  return searchTools.has(key.slice(0, key.indexOf("\u0000")));
}

const searchResultSchema = z.union([
  z.object({ messages: z.array(z.unknown()) }),
  z.object({ files: z.array(z.unknown()) }),
]);

/** Whether a search came back with an empty list. */
function foundNothing(output: ToolResultPart["output"]) {
  if (output.type !== "json") return false;
  const result = searchResultSchema.safeParse(output.value).data;
  if (result === undefined) return false;
  return ("messages" in result ? result.messages : result.files).length === 0;
}

function isRateLimitFailure(output: ToolResultPart["output"]) {
  return (
    output.type.startsWith("error") &&
    JSON.stringify(output).includes(googleRateLimitMessage)
  );
}

/**
 * What the guarded reads of the current turn did, from its history. A Google
 * write clears what the turn read before it, so reading again runs.
 */
export function turnReads(
  messages: readonly ModelMessage[],
  limits: TurnReadLimits = turnReadLimits.interactive
): TurnReads {
  const keys = new Map<string, string>();
  const googleAppsRuns = new Set<string>();
  const done = new Set<string>();
  let count = 0;
  let emptySearches = 0;
  let rateLimited = false;
  let refused = 0;
  for (const message of currentTurnMessages(messages)) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (part.type === "tool-call") {
        const call = googleReadCallSchema.safeParse(part).data;
        if (call) keys.set(part.toolCallId, googleReadKey(call));
        if (googleAppsRunSchema.safeParse(part).success) {
          googleAppsRuns.add(part.toolCallId);
        }
        continue;
      }
      if (part.type !== "tool-result") continue;
      const changedGoogle = googleWriteTools.has(part.toolName)
        ? succeeded(part.output)
        : googleAppsRuns.has(part.toolCallId) && appsWrote(part.output);
      if (changedGoogle) {
        done.clear();
        continue;
      }
      const key = keys.get(part.toolCallId);
      if (key === undefined) continue;
      if (isRefusal(part.output)) {
        refused += 1;
        continue;
      }
      count += 1;
      if (isRateLimitFailure(part.output)) rateLimited = true;
      else if (succeeded(part.output)) done.add(key);
      if (isSearchKey(key) && foundNothing(part.output)) emptySearches += 1;
    }
  }
  return {
    count,
    done: [...done],
    emptySearchLimit: limits.emptySearches,
    emptySearches,
    limit: limits.reads,
    rateLimited,
    refused,
  };
}

/**
 * Messages the current turn already changed through `gmail-update`, so the
 * bulk approval counts the whole turn: four calls of three messages are one
 * bulk change, not four small ones.
 */
export function turnGmailUpdates(messages: readonly ModelMessage[]) {
  const ids = new Map<string, readonly string[]>();
  const updated = new Set<string>();
  for (const message of currentTurnMessages(messages)) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (part.type === "tool-call" && part.toolName === "gmail-update") {
        const input = gmailUpdateInputSchema.safeParse(part.input).data;
        if (input) ids.set(part.toolCallId, input.messageIds);
      }
      if (
        part.type === "tool-result" &&
        part.toolName === "gmail-update" &&
        succeeded(part.output)
      ) {
        for (const id of ids.get(part.toolCallId) ?? []) updated.add(id);
      }
    }
  }
  return updated.size;
}

const readThreadOutputSchema = z.object({
  thread: z.object({
    messages: z.array(z.object({ id: z.string().nullable() })),
  }),
});

/**
 * Gmail ids of the messages whose thread the conversation has read with
 * `gmail-read-thread`, whose answer carries the person's own earlier emails
 * to that addressee. A reply is written only after that read, so it can be
 * in their voice (RU d09, EN D5).
 */
export function readGmailMessageIds(messages: readonly ModelMessage[]) {
  const ids = new Set<string>();
  for (const message of messages) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (
        part.type !== "tool-result" ||
        part.toolName !== "gmail-read-thread" ||
        part.output.type !== "json"
      ) {
        continue;
      }
      const read = readThreadOutputSchema.safeParse(part.output.value).data;
      for (const { id } of read?.thread.messages ?? []) {
        if (id !== null) ids.add(id);
      }
    }
  }
  return [...ids];
}

/**
 * Whether the person declined a `gmail-send` card in this turn and no draft
 * was saved after it. The email they did not send is kept as a draft (RU d09:
 * «отправляет после подтверждения или оставляет черновик»), so `gmail-draft`
 * says so in the next step. A send the policy refused — read-only, Google
 * not connected — never showed a card and does not count.
 */
export function turnDeclinedGmailSend(messages: readonly ModelMessage[]) {
  const sends = new Set<string>();
  const cards = new Set<string>();
  let declined = false;
  for (const message of currentTurnMessages(messages)) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (part.type === "tool-call") {
        if (part.toolName === "gmail-send") sends.add(part.toolCallId);
        if (part.toolName === "gmail-draft") declined = false;
      } else if (part.type === "tool-approval-request") {
        if (sends.has(part.toolCallId)) cards.add(part.approvalId);
      } else if (
        part.type === "tool-approval-response" &&
        cards.has(part.approvalId)
      ) {
        declined = !part.approved;
      }
    }
  }
  return declined;
}

/**
 * Why a read must not reach Google, given the turn so far, or nothing when
 * it may run. A read that failed for another reason may be tried again.
 */
export function readRefusalReason(
  key: string,
  reads: TurnReads
): RefusalReason | undefined {
  if (reads.rateLimited) return "rate_limited";
  if (reads.done.includes(key)) return "duplicate";
  if (isSearchKey(key) && reads.emptySearches >= reads.emptySearchLimit) {
    return "empty_searches";
  }
  if (reads.count >= reads.limit) return "limit";
  return undefined;
}

/**
 * Whether the turn has to end now because the model keeps asking for reads
 * this guard refuses: another step may only write the closing text.
 */
export function readsMustEnd(messages: readonly ModelMessage[]) {
  return turnReads(messages).refused >= refusalsBeforeEnd;
}
