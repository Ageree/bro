import { createHash } from "node:crypto";
import { z } from "zod";
import { callConversationOf } from "./warm";

/**
 * Where a chat call's cached prefix broke (18.10). The host caches the
 * longest prefix it saw before, and a person's first step in Telegram read
 * only 54% of its ≈ 115k tokens from the cache over two weeks, 41% of those
 * turns under 30%: each such step waited seconds longer. This line names the
 * first message (or the tool block) that differs from the session's previous
 * call, so the cause is a log away. A short hash of every message is kept
 * per session by the serving instance, never the text, and nothing of a
 * message reaches the log but its role.
 *
 * The session is the one `warmCallMiddleware` marks (a person's turns);
 * a call without it is not compared. Until 19.10 calls were matched by
 * their first message after the system ones, and that message is the same
 * in every conversation (Bro's own preamble): the line compared different
 * sessions with each other and reported `toolsChanged` and a break at the
 * end of the preamble for calls whose own prefix had held.
 *
 * RunInfra puts the tool block before the system prompt (19.10, direct
 * calls of 26k tokens): any change of the block leaves nothing of the
 * prompt cached, so `toolsChanged` means the whole call was read cold.
 */
const conversations = new Map<
  string,
  { readonly hashes: readonly string[]; readonly tools: string }
>();
const maximumConversations = 200;

const callSchema = z.object({
  messages: z.array(z.looseObject({ role: z.string() })),
  tools: z.array(z.json()).optional(),
});

function hashOf(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Logs `[model] prefix` for a chat call's JSON body; never throws. */
export function notePrefix(body: string) {
  try {
    const sessionId = callConversationOf();
    if (sessionId === undefined) return;
    const call = callSchema.safeParse(JSON.parse(body)).data;
    if (call === undefined) return;
    const texts = call.messages.map((message) => JSON.stringify(message));
    const hashes = texts.map((text) => hashOf(text));
    const lengths = texts.map((text) => text.length);
    const tools = hashOf(JSON.stringify(call.tools ?? []));
    const before = conversations.get(sessionId);
    conversations.delete(sessionId);
    conversations.set(sessionId, { hashes, tools });
    if (conversations.size > maximumConversations) {
      const oldest = conversations.keys().next().value;
      if (oldest !== undefined) conversations.delete(oldest);
    }
    if (before === undefined) return;
    const shared = hashes.findIndex(
      (hash, index) => before.hashes[index] !== hash
    );
    const brokeAt =
      shared === -1 ? Math.min(hashes.length, before.hashes.length) : shared;
    const total = lengths.reduce((sum, length) => sum + length, 0);
    const kept = lengths
      .slice(0, brokeAt)
      .reduce((sum, length) => sum + length, 0);
    console.info("[model] prefix", {
      brokeAt,
      brokeRole: call.messages[brokeAt]?.role,
      // The share of this call's messages, by characters, before the break.
      keptShare: total === 0 ? 1 : Math.round((kept / total) * 100) / 100,
      messages: hashes.length,
      previous: before.hashes.length,
      sessionId,
      toolsChanged: before.tools !== tools,
    });
  } catch {
    // A diagnostic line never costs the call.
  }
}
