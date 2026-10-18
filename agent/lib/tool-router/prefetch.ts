import { z } from "zod";
import { toolRouterAsksWorkspace } from "./pilot";
import { routerState } from "./state-string";
import { askRouterQuestions, type RouterAnswer } from "./system-one";

/**
 * The router's decision asked ahead of the turn (18.10). A person's first
 * step waited for Jev: 0.45 s warm on the owner's Telegram turns, up to
 * 1.5 s, before the model was called at all. A channel that holds the
 * person's words and Bro's last message before eve dispatches the turn asks
 * at once, and the step takes the answer by the state string's digest
 * (`routerAnswerAhead`), so the question runs while the turn is queued. The
 * state comes from the same function as the step's (`routerState`): a
 * message the channel reads otherwise — a photo, a forward, an answer to a
 * card — only misses, and the step asks as before. Held by the serving
 * instance, at most a minute and a few dozen answers.
 */
const heldForMs = 60_000;
const maximumHeld = 64;
const maximumConversations = 500;
const waitMs = 1500;

const ahead = new Map<
  string,
  { readonly answer: Promise<RouterAnswer>; readonly at: number }
>();

/** Asks the router's questions about a turn that has not started yet. */
export function askRouterAhead(turn: {
  readonly previous: string | undefined;
  readonly words: string;
}) {
  const now = Date.now();
  for (const [digest, held] of ahead) {
    if (now - held.at > heldForMs) ahead.delete(digest);
  }
  const { digest, state } = routerState({ answers: [], ...turn });
  if (ahead.has(digest)) return;
  if (ahead.size >= maximumHeld) {
    const oldest = ahead.keys().next().value;
    if (oldest !== undefined) ahead.delete(oldest);
  }
  ahead.set(digest, { answer: askRouterQuestions(state, waitMs), at: now });
}

/**
 * Bro's last message in each conversation (a Telegram chat, a web session),
 * as the model wrote it: what the router's state names as «Предыдущее
 * сообщение Бро» (`lastSend` in `state-string.ts`). Not known after a restart
 * until Bro writes again: the router then asks at the step, as before.
 */
const lastSent = new Map<string, string>();
const sendCallSchema = z.object({
  input: z.object({ text: z.string() }),
  toolName: z.literal("send_message"),
});

/** Keeps the text of the last `send_message` among a step's calls. */
export function noteBroMessage(
  conversation: string,
  actions: readonly unknown[]
) {
  const text = actions
    .flatMap((action) => sendCallSchema.safeParse(action).data ?? [])
    .at(-1)?.input.text;
  if (text === undefined) return;
  lastSent.delete(conversation);
  lastSent.set(conversation, text);
  if (lastSent.size > maximumConversations) {
    const oldest = lastSent.keys().next().value;
    if (oldest !== undefined) lastSent.delete(oldest);
  }
}

/**
 * Asks about the person's text before its turn starts, in the router's pilot
 * and once Bro's last message there is known.
 */
export function askRouterAboutNext(turn: {
  readonly conversation: string;
  readonly words: string;
  readonly workspaceId: string;
}) {
  const previous = lastSent.get(turn.conversation);
  if (previous === undefined || turn.words.trim() === "") return;
  if (!toolRouterAsksWorkspace(turn.workspaceId)) return;
  askRouterAhead({ previous, words: turn.words });
}

/** The answer asked ahead for this state, taken once; else undefined. */
export function routerAnswerAhead(digest: string) {
  const held = ahead.get(digest);
  if (held === undefined) return undefined;
  ahead.delete(digest);
  return Date.now() - held.at > heldForMs ? undefined : held.answer;
}
