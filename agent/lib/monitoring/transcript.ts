import type { JsonValue } from "eve/connections";
import type { HookContext } from "eve/hooks";
import { turnLogEntryLimit } from "@db";
import { withoutSecrets } from "@agent/lib/privacy/secrets";
import { env } from "@shared/environment";

/**
 * Whether the turn log keeps the text of turns (OWNER_TRANSCRIPTS). Off by
 * default: the owner turns it on once people have agreed to it.
 */
export function transcriptsEnabled() {
  return env.OWNER_TRANSCRIPTS === "on";
}

/** A transcript line's text: cut to the entry's limit, secrets cut out. */
export function transcriptText(text: string) {
  return withoutSecrets(text, turnLogEntryLimit);
}

/**
 * A field whose name says it holds a secret is dropped, name and all,
 * before the filters read the rest. The text filters want a word for a
 * code or a password, and an argument's key is that word: a kept
 * `"password":` would cut everything after it in the line.
 */
const secretKeyPattern =
  /pass(?:word|code|phrase)?|secret|token|otp|cvv|cvc|pin$|^code$|card_?number|cardNumber|^sig$|signature|api_?key|authorization|cookie/iu;

/**
 * A tool's arguments or result as one transcript line: JSON without the
 * fields named as secrets, then cut and filtered as any text. A
 * long result loses everything past the cut — a page or a mail body is
 * not the owner's to read in full.
 */
export function transcriptJson(value: JsonValue) {
  const json = JSON.stringify(value, (key, field: JsonValue) =>
    key.length > 0 && secretKeyPattern.test(key) ? undefined : field
  );
  return transcriptText(json);
}

/** The channel a turn reached Bro through, as the owner reads it. */
const channelNames = new Map([
  ["channel:eve", "web"],
  ["channel:photon", "imessage"],
  ["channel:telegram", "telegram"],
]);

export function turnChannel(context: Pick<HookContext, "channel">) {
  const { kind } = context.channel;
  if (kind === undefined) return "unknown";
  return channelNames.get(kind) ?? kind.replace(/^channel:/u, "");
}
