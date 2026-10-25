import { defineState } from "eve/context";
import type { z } from "zod";
import type { sendMessageOutputSchema } from "@shared/chat/message-delivery";

type SentMessage = z.infer<typeof sendMessageOutputSchema>;

/**
 * The invite links `bro_network invite` made last, kept in eve's durable
 * session state. A model copies their 32-character token unreliably: on
 * 25.10 DeepSeek dropped its last character from both links of one invite,
 * and the person invited would have opened an unknown one. So
 * `send_message` puts these exact links in the text it sends, whatever the
 * model wrote where they belong, as it does the sign-in link
 * (`agent/lib/login-handoff/exact-link.ts`).
 */
const issuedInvite = defineState<{
  readonly telegram: string | null;
  readonly web: string | null;
}>("bro.bro-to-bro-invite-links", () => ({ telegram: null, web: null }));

/** An invite link inside text, with or without its scheme, as a model writes it. */
const telegramInvite = /(?:https?:\/\/)?t\.me\/\w+\?start=bro_[\w-]+/giu;
const webInvite =
  /(?:https?:\/\/)?[a-z0-9.-]+\/workspace\?bro_invite=[\w-]+/giu;

/** Records the links an invite was just made with. */
export function recordBroInviteLinks(links: {
  readonly telegram: string | null;
  readonly web: string | null;
}) {
  issuedInvite.update(() => links);
}

function mended(text: string) {
  const { telegram, web } = readIssuedInvite();
  const withTelegram =
    telegram === null ? text : text.replace(telegramInvite, () => telegram);
  return web === null
    ? withTelegram
    : withTelegram.replace(webInvite, () => web);
}

/**
 * The message with every invite link in it replaced by the one of the
 * invite made last, so the person forwards the link byte for byte. A
 * message without one, or before any invite was made, goes out as written.
 */
export function withExactBroInviteLinks<Message extends SentMessage>(
  message: Message
): Message {
  if (message.kind === "link") {
    const url = mended(message.url);
    return url === message.url ? message : { ...message, url };
  }
  if (message.text === undefined) return message;
  const text = mended(message.text);
  return text === message.text ? message : { ...message, text };
}

function readIssuedInvite() {
  try {
    return issuedInvite.get();
  } catch (error) {
    // Outside eve's context nothing was recorded: the text goes out as written.
    console.warn("[bro-to-bro] issued invite links not read", { cause: error });
    return { telegram: null, web: null };
  }
}
