import type { ModelMessage } from "ai";
import { z } from "zod";

/**
 * The Afisha sessions of this conversation, for `yandex_purchase` to buy from.
 * A model copies a session's long base64 key unreliably: 22.10 it turned
 * `…fDE3OTUxOTQw…` into `…fDE3OTE5NDAw…`, Afisha answered 404, and Bro went
 * to the browser. So the session is named by its time too, and the link
 * comes from what `afisha.prices` gave in this conversation.
 */
export interface AfishaSession {
  readonly link: string;
  /** Its time as `afisha.prices` gives it (2026-11-20T20:00), or null for a link the person sent. */
  readonly when: string | null;
}

const sessionLink =
  /https:\/\/widget\.afisha\.yandex\.ru\/w\/sessions\/[A-Za-z0-9+/=_%-]{8,200}/gu;

const pricedSessions = z.object({
  data: z.object({
    sessions: z.array(
      z.object({ link: z.string().nullable(), when: z.string().nullable() })
    ),
  }),
});

/** A link without its query: the widget's own `?widgetName=…` is not the session. */
const base = (link: string) => link.split("?")[0] ?? link;

/**
 * The sessions `afisha.prices` answered with in this conversation, and the
 * session links the person sent; never a link the model wrote itself.
 */
export function knownAfishaSessions(
  messages: readonly ModelMessage[]
): readonly AfishaSession[] {
  const known = new Map<string, AfishaSession>();
  for (const message of messages) {
    if (message.role === "user") {
      for (const link of JSON.stringify(message.content).match(sessionLink) ??
        []) {
        if (!known.has(link)) known.set(link, { link, when: null });
      }
    }
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (
        part.type !== "tool-result" ||
        part.toolName !== "yandex" ||
        part.output.type !== "json"
      ) {
        continue;
      }
      const priced = pricedSessions.safeParse(part.output.value);
      for (const { link, when } of priced.data?.data.sessions ?? []) {
        if (link !== null) known.set(base(link), { link: base(link), when });
      }
    }
  }
  return [...known.values()];
}

const afishaCall = z.object({ operation: z.string().startsWith("afisha.") });

/**
 * Whether Bro asked Afisha's API (`yandex` with an `afisha.*` operation) in
 * this conversation, whatever it answered: until then an errand on Afisha's
 * site waits for it (`browser_task`).
 */
export function afishaApiAsked(messages: readonly ModelMessage[]) {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) =>
          part.type === "tool-call" &&
          part.toolName === "yandex" &&
          afishaCall.safeParse(part.input).success
      )
  );
}

/**
 * The link of the session the model means: its own when the conversation
 * knows it, else the one known session of that time, else none. Nothing is
 * known (the history was cut) — the model's link stands, and Afisha says
 * whether it is a session.
 */
export function afishaSessionLink(
  given: { readonly link: string; readonly when: string },
  known: readonly AfishaSession[]
) {
  if (known.length === 0) return given.link;
  if (known.some(({ link }) => link === base(given.link))) return given.link;
  const sameTime = known.filter(({ when }) => when === given.when);
  return sameTime.length === 1 ? sameTime[0]?.link : undefined;
}
