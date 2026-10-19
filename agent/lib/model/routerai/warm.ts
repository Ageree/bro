import { AsyncLocalStorage } from "node:async_hooks";
import type { LanguageModelMiddleware } from "ai";
import { env } from "@shared/environment";

/**
 * RunInfra keeps a prompt cached from 45 minutes to two hours or more,
 * seemingly by its load (18.10), and a person who writes to Bro less often
 * than that is answered from a cold prompt: the owner's Telegram step of 62k
 * tokens took 3.2–3.7 s uncached against 1.5 s cached. So a person's
 * conversation is kept warm: once its calls go quiet for `everyMs`, its last
 * prompt goes to RunInfra again for a single token, up to `maximumPings`
 * times, each read well inside the shortest life seen. A ping of 49k cached
 * tokens cost 0.043 ₽ (`[model] warm`). The prompts are held by the serving
 * instance (a restart drops them, as the cache is warmed again by the next
 * turn); a ping never reaches RouterAI and its failure never keeps a real
 * call off RunInfra.
 */
const everyMs = 40 * 60_000;
const maximumPings = 3;
// A prompt is up to a few hundred kilobytes of JSON.
const maximumConversations = 100;

/** The conversation whose call this is, set by `warmCallMiddleware`. */
const callConversation = new AsyncLocalStorage<string>();

const held = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The session whose model call this is, when `warmCallMiddleware` marked
 * it: the `[model] call` and `[model] prefix` lines name it, so a call is
 * lined up with its session's `[tools]` line and its previous call.
 */
export function callConversationOf() {
  return callConversation.getStore();
}

/**
 * Whether PROMPT_WARM_WORKSPACES names a workspace by id or `*`: a pure read
 * of the environment, so every step can ask it.
 */
export function promptWarmWorkspace(workspaceId: string) {
  const list = env.PROMPT_WARM_WORKSPACES ?? [];
  return list.includes("*") || list.includes(workspaceId);
}

/**
 * Marks the model calls of a step as `conversation`'s, so the call that
 * reaches RunInfra is the one its next pause keeps warm (`keepWarm`).
 */
export function warmCallMiddleware(
  conversation: string
): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate }) =>
      callConversation.run(conversation, doGenerate),
    wrapStream: async ({ doStream }) =>
      callConversation.run(conversation, doStream),
  };
}

/**
 * After RunInfra answered a call: when the call is a marked conversation's,
 * `ping()` (the same prompt for one token) goes through `send` once the
 * conversation's calls have been quiet for `everyMs`, and again after each
 * ping that `send` reports done, up to `maximumPings`. A newer call of the
 * conversation takes the place of the older one's pings.
 */
export function keepWarm(
  ping: () => string,
  send: (body: string) => Promise<boolean>
) {
  const conversation = callConversation.getStore();
  if (conversation === undefined) return;
  clearTimeout(held.get(conversation));
  held.delete(conversation);
  schedule(conversation, ping(), send, 1);
  if (held.size > maximumConversations) {
    const [oldest, timer] = held.entries().next().value ?? [];
    clearTimeout(timer);
    if (oldest !== undefined) held.delete(oldest);
  }
}

function schedule(
  conversation: string,
  ping: string,
  send: (body: string) => Promise<boolean>,
  round: number
) {
  const timer = setTimeout(() => {
    void pingAgain(conversation, timer, ping, send, round);
  }, everyMs);
  // A pending ping never keeps the process alive.
  timer.unref();
  held.set(conversation, timer);
}

async function pingAgain(
  conversation: string,
  timer: ReturnType<typeof setTimeout>,
  ping: string,
  send: (body: string) => Promise<boolean>,
  round: number
) {
  const done = await send(ping);
  // A newer call of the conversation holds its own pings now.
  if (held.get(conversation) !== timer) return;
  if (!done || round >= maximumPings) {
    held.delete(conversation);
    return;
  }
  schedule(conversation, ping, send, round + 1);
}
