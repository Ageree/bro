import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Where a chat call's cached prefix broke (18.10). The host caches the
 * longest prefix it saw before, and a person's first step in Telegram read
 * only 54% of its ≈ 115k tokens from the cache over two weeks, 41% of those
 * turns under 30%: each such step waited seconds longer. This line names the
 * first message (or the tool block) that differs from the conversation's
 * previous call, so the cause is a log away. Calls of one conversation share
 * their first message after the system ones; a short hash of every message
 * is kept per conversation by the serving instance, never the text, and
 * nothing of a message reaches the log but its role.
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
    const call = callSchema.safeParse(JSON.parse(body)).data;
    if (call === undefined) return;
    const opening = call.messages.findIndex(
      (message) => message.role !== "system"
    );
    if (opening === -1) return;
    const texts = call.messages.map((message) => JSON.stringify(message));
    const key = hashOf(texts[opening] ?? "");
    const hashes = texts.map((text) => hashOf(text));
    const lengths = texts.map((text) => text.length);
    const tools = hashOf(JSON.stringify(call.tools ?? []));
    const before = conversations.get(key);
    conversations.delete(key);
    conversations.set(key, { hashes, tools });
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
      toolsChanged: before.tools !== tools,
    });
  } catch {
    // A diagnostic line never costs the call.
  }
}
