import type { ModelMessage, ToolResultPart } from "ai";
import { z } from "zod";
import { currentTurnMessages } from "@agent/lib/delivery/turn-sends";
import { googleRateLimitMessage } from "./client";
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
 */
export const turnReadLimits = { background: 60, interactive: 20 } as const;

/**
 * Gmail writes after which what the turn read may no longer be what the
 * mailbox holds: a search repeated after archiving must reach Google.
 */
const gmailWriteTools = new Set(["gmail-draft", "gmail-send", "gmail-update"]);

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
]);

type GoogleReadCall = z.infer<typeof googleReadCallSchema>;

/**
 * Identifies one guarded read by what it asks Google for, so the same search
 * is recognised whether or not the model spelled out a default.
 */
export function googleReadKey(call: GoogleReadCall) {
  return call.toolName === "gmail-search"
    ? `${call.toolName}\u0000${String(call.input.maxResults)}\u0000${call.input.query.trim()}`
    : `${call.toolName}\u0000${call.input.threadId.trim()}`;
}

/** What the current turn's guarded reads did so far. */
export interface TurnReads {
  /** Reads that reached Google, successful or not. */
  readonly count: number;
  /** Reads this turn may make before the guard refuses more. */
  readonly limit: number;
  /** Keys of reads that returned a result the model already holds. */
  readonly done: readonly string[];
  /** Whether a read this turn ended in Google's rate or quota refusal. */
  readonly rateLimited: boolean;
  /** Reads refused by this guard. */
  readonly refused: number;
}

export type RefusalReason = "duplicate" | "limit" | "rate_limited";

const refusedPrefix = "Not run:";

const refusalNotices = {
  duplicate: `${refusedPrefix} this exact call already ran in this turn and its result is above. Use that result instead of calling again; if you need something else, change the query.`,
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

function isRateLimitFailure(output: ToolResultPart["output"]) {
  return (
    output.type.startsWith("error") &&
    JSON.stringify(output).includes(googleRateLimitMessage)
  );
}

/**
 * What the guarded reads of the current turn did, from its history. A Gmail
 * write clears what the turn read before it, so reading again runs.
 */
export function turnReads(
  messages: readonly ModelMessage[],
  limit: number = turnReadLimits.interactive
): TurnReads {
  const keys = new Map<string, string>();
  const done = new Set<string>();
  let count = 0;
  let rateLimited = false;
  let refused = 0;
  for (const message of currentTurnMessages(messages)) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts) {
      if (part.type === "tool-call") {
        const call = googleReadCallSchema.safeParse(part).data;
        if (call) keys.set(part.toolCallId, googleReadKey(call));
        continue;
      }
      if (part.type !== "tool-result") continue;
      if (gmailWriteTools.has(part.toolName) && succeeded(part.output)) {
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
    }
  }
  return { count, done: [...done], limit, rateLimited, refused };
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
