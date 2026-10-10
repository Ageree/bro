import { defineState } from "eve/context";
import type { z } from "zod";
import type { sendMessageOutputSchema } from "@shared/chat/message-delivery";

/**
 * The sign-in link `site-login-link` made last, kept in eve's durable session
 * state. A model copies a long random id unreliably: DeepSeek dropped the
 * tail of one (10.10, `…/handoff/uU9hry_OH-oo21PlwBlXGYQD-WlOVCI7` went out
 * as `…XGXl`). So `send_message` puts this exact address into the text it
 * sends, whatever the model wrote where the link belongs.
 */
const issuedLink = defineState<{ readonly link: string | null }>(
  "bro.login-handoff-link",
  () => ({ link: null })
);

/** A sign-in address inside text, with or without its scheme, as a model writes it. */
const handoffAddress = /(?:https?:\/\/)?[a-z0-9.-]*\/handoff\/[a-z0-9_-]+/giu;

/** Records the link `site-login-link` has just made. */
export function recordLoginHandoffLink(link: string) {
  issuedLink.update(() => ({ link }));
}

/**
 * The message with every sign-in address in it replaced by the link made
 * last, so the person gets the link byte for byte. A message without one, or
 * before any link was made, goes out as written.
 */
export function withExactLoginHandoffLink<
  Message extends z.infer<typeof sendMessageOutputSchema>,
>(message: Message): Message {
  const { link } = readIssuedLink();
  if (link === null) return message;
  if (message.kind === "link") {
    return message.url.includes("/handoff/")
      ? { ...message, url: link }
      : message;
  }
  if (message.text === undefined) return message;
  const text = message.text.replace(handoffAddress, link);
  return text === message.text ? message : { ...message, text };
}

function readIssuedLink() {
  try {
    return issuedLink.get();
  } catch (error) {
    // Outside eve's context nothing was recorded: the text goes out as written.
    console.warn("[login-handoff] issued link not read", { cause: error });
    return { link: null };
  }
}
