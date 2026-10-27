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
 * The workspace of a turn from /talk's voice (`fastVoiceTurn`), set by
 * `warmCallMiddleware` beside the conversation: its last prompt is what a new
 * voice conversation of the workspace shares up to its history — the tool
 * block, the instructions and memory (`warmVoicePrompt`).
 */
const callVoice = new AsyncLocalStorage<string>();

const voicePrompts = new Map<
  string,
  {
    readonly at: number;
    readonly ping: string;
    pingedAt?: number;
    readonly send: (body: string) => Promise<boolean>;
  }
>();
/** A voice prompt older than this is not sent again: what it held may be gone. */
const voicePromptLifeMs = 12 * 60 * 60_000;
/** A warm prompt needs no second ping this soon: a page reloaded, a call retried. */
const voiceRepingMs = 10 * 60_000;

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
  conversation: string,
  voiceWorkspace?: string
): LanguageModelMiddleware {
  const marked = <T>(call: () => T) =>
    callConversation.run(conversation, () =>
      voiceWorkspace === undefined
        ? call()
        : callVoice.run(voiceWorkspace, call)
    );
  return {
    wrapGenerate: async ({ doGenerate }) => marked(doGenerate),
    wrapStream: async ({ doStream }) => marked(doStream),
  };
}

/**
 * When /talk opens (`agent/channels/voice.ts`): the workspace's last voice
 * prompt goes to RunInfra once more for one token, so the first question of
 * the new conversation reads its tool block and instructions from the cache.
 * A voice conversation is opened after long pauses, past the cache's life,
 * and its first step then read 40–85k tokens cold (3–3.8 s, 27.10). Nothing
 * held — a first conversation, a restart since — sends nothing.
 */
export function warmVoicePrompt(workspaceId: string) {
  const last = voicePrompts.get(workspaceId);
  const now = Date.now();
  if (last === undefined || now - last.at > voicePromptLifeMs) return;
  if (last.pingedAt !== undefined && now - last.pingedAt < voiceRepingMs)
    return;
  last.pingedAt = now;
  void last.send(last.ping).catch(() => false);
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
  const body = ping();
  const voice = callVoice.getStore();
  if (voice !== undefined) {
    voicePrompts.delete(voice);
    voicePrompts.set(voice, { at: Date.now(), ping: body, send });
    if (voicePrompts.size > maximumConversations) {
      const [oldest] = voicePrompts.keys();
      if (oldest !== undefined) voicePrompts.delete(oldest);
    }
  }
  clearTimeout(held.get(conversation));
  held.delete(conversation);
  schedule(conversation, body, send, 1);
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
