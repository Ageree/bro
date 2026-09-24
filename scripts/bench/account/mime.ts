/**
 * Builds the raw RFC 5322 message Gmail's `messages.insert` takes: UTF-8 text
 * as base64, non-ASCII headers as RFC 2047 encoded words, and the threading
 * headers Gmail needs to put a reply into its thread.
 */

export interface MailParty {
  readonly address: string;
  readonly name?: string;
}

// An encoded word stays within 75 characters: 45 bytes of text encode to 60
// base64 characters inside `=?UTF-8?B?…?=`.
const encodedWordBytes = 45;

/** A header value as ASCII: itself, or folded RFC 2047 encoded words. */
export function encodeHeaderText(text: string) {
  if (/^[\x20-\x7e]*$/u.test(text)) return text;
  const words: string[] = [];
  let chunk = "";
  for (const character of text) {
    const next = chunk + character;
    if (Buffer.byteLength(next) > encodedWordBytes) {
      words.push(chunk);
      chunk = character;
    } else {
      chunk = next;
    }
  }
  if (chunk) words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`)
    .join("\r\n ");
}

function formatParty(party: MailParty) {
  if (!party.name) return `<${party.address}>`;
  const name = /^[\w .-]*$/u.test(party.name)
    ? `"${party.name}"`
    : encodeHeaderText(party.name);
  return `${name} <${party.address}>`;
}

const wrap = (text: string, width: number) =>
  text.match(new RegExp(`.{1,${String(width)}}`, "gu")) ?? [];

export function buildMessage(message: {
  readonly body: string;
  /** The `Date:` header, already in the sender's zone (`mailDate`). */
  readonly date: string;
  /** `X-Bro-Bench`: which fixture this is, for anyone reading the headers. */
  readonly fixture: string;
  readonly from: MailParty;
  readonly inReplyTo: string | undefined;
  /** `List-Unsubscribe` of a newsletter, `<https://…>`. */
  readonly listUnsubscribe: string | undefined;
  readonly messageId: string;
  readonly subject: string;
  readonly to: MailParty;
}) {
  const headers = [
    `From: ${formatParty(message.from)}`,
    `To: ${formatParty(message.to)}`,
    `Subject: ${encodeHeaderText(message.subject)}`,
    `Date: ${message.date}`,
    `Message-ID: ${message.messageId}`,
    ...(message.inReplyTo
      ? [
          `In-Reply-To: ${message.inReplyTo}`,
          `References: ${message.inReplyTo}`,
        ]
      : []),
    `X-Bro-Bench: ${message.fixture}`,
    ...(message.listUnsubscribe
      ? [`List-Unsubscribe: ${message.listUnsubscribe}`]
      : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = wrap(
    Buffer.from(message.body.replaceAll(/\r?\n/gu, "\r\n")).toString("base64"),
    76
  );
  return [...headers, "", ...body, ""].join("\r\n");
}

/** Gmail's `raw`: the whole message as URL-safe base64. */
export function base64Url(text: string) {
  return Buffer.from(text).toString("base64url");
}
