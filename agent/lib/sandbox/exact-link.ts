import type { ModelMessage } from "ai";
import type { z } from "zod";
import { reportedSharedFileLinks } from "@agent/lib/browser-use/files";
import { taskAgentTool } from "@agent/lib/turn-kind/sets";
import type { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import { isSharedFileLink, sandboxFilesPath } from "./files";

/**
 * The task agent's file links, as the model copies them. A link carries a
 * 24-hex id, the file's name and a 43-character signature, and a model
 * copies such a tail unreliably: a character wrong, the signature cut, the
 * name decoded with its spaces (as the login handoff's link before it,
 * `agent/lib/login-handoff/exact-link.ts`). Each is mended into the link of
 * this conversation it stands for, when one alone fits; a link of no file
 * of this conversation stays as written.
 */

type SentMessage = z.infer<typeof sendMessageOutputSchema>;

const linkPattern = /https:\/\/[^\s<>"'\\)\]]+/gu;
/** A link's id and the name after it, however mangled the rest. */
const looseParts = new RegExp(
  `${sandboxFilesPath}/([\\da-f]{8,24})(?:/([^?#]*))?`,
  "u"
);
/**
 * A link in text as a model writes it, with or without its scheme: a host,
 * the path, and its tail up to a space, a quote or a bracket.
 */
const looseLink = new RegExp(
  `(?:https?://)?[\\w.-]*(?::\\d+)?${sandboxFilesPath}/[^\\s"'<>()[\\]]+`,
  "gu"
);
const signature = /sig=[\w-]+/u;
/** How far a link cut at a space in its name is looked after for its `sig`. */
const signatureReach = 300;
const idChars = 24;
const minimumIdChars = 12;
const knownLinksKept = 100;

/** The task results' text: what a `task` call answered, never its files. */
function taskResultTexts(messages: readonly ModelMessage[]) {
  return messages.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => {
          if (part.type !== "tool-result" || part.toolName !== taskAgentTool) {
            return [];
          }
          if (part.output.type === "text") return [part.output.value];
          if (part.output.type === "json") {
            return [JSON.stringify(part.output.value)];
          }
          return [];
        })
      : []
  );
}

/**
 * The share links of this conversation: the ones the person or a task
 * report brought (`reportedSharedFileLinks`) and the ones a `task` call
 * answered with, the last hundred.
 */
export function knownSharedLinks(
  messages: readonly ModelMessage[]
): readonly string[] {
  const links = new Set(reportedSharedFileLinks(messages));
  for (const text of taskResultTexts(messages)) {
    for (const [link] of text.matchAll(linkPattern)) {
      if (isSharedFileLink(link)) links.add(link);
    }
  }
  return [...links].slice(-knownLinksKept);
}

function decoded(name: string) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** A link's id and name, or a bare id, or a bare name. */
function partsOf(value: string) {
  const match = looseParts.exec(value);
  if (match !== null) {
    const [, id = "", name] = match;
    return { id, name: name === undefined ? undefined : decoded(name) };
  }
  const bare = value.trim();
  if (/^[\da-f]{24}$/u.test(bare)) return { id: bare, name: undefined };
  return { id: undefined, name: bare === "" ? undefined : bare };
}

function differingChars(a: string, b: string) {
  let differ = 0;
  for (let at = 0; at < a.length; at += 1) {
    if (a[at] !== b[at]) differ += 1;
  }
  return differ;
}

/** The only one of `links`, if there is exactly one. */
function only(links: readonly string[]) {
  return links.length === 1 ? links[0] : undefined;
}

/**
 * The known link `value` stands for: itself when it is one, else the known
 * link with its id, the only one with its name, or the only one whose id
 * starts with its 12 or more hex or is within two characters of its 24;
 * failing those, itself when it is a valid link all the same (its name
 * decoded, which a URL parser accepts, comes back as the known link);
 * undefined when none or several fit.
 */
export function exactSharedLink(value: string, known: readonly string[]) {
  if (known.includes(value)) return value;
  return (
    knownLinkFor(value, known) ?? (isSharedFileLink(value) ? value : undefined)
  );
}

function knownLinkFor(value: string, known: readonly string[]) {
  const wanted = partsOf(value);
  const links = known.map((link) => ({ link, ...partsOf(link) }));
  const { id, name } = wanted;
  if (id !== undefined) {
    const same = links.find((link) => link.id === id);
    if (same !== undefined) return same.link;
  }
  if (name !== undefined) {
    const named = only(
      links.filter((link) => link.name === name).map(({ link }) => link)
    );
    if (named !== undefined) return named;
  }
  if (id === undefined || id.length < minimumIdChars) return undefined;
  return only(
    links
      .filter(
        (link) =>
          link.id !== undefined &&
          (link.id.startsWith(id) ||
            (id.length === idChars && differingChars(id, link.id) <= 2))
      )
      .map(({ link }) => link)
  );
}

/**
 * The link as it stands in `text` from `start`: when it has no `sig`, it
 * runs on through the first one on the same line within reach (a name the
 * model decoded, spaces and all), unless another link comes first.
 */
function linkExtent(text: string, start: number, written: string) {
  if (signature.test(written)) return written;
  const rest = text.slice(start + written.length, start + signatureReach);
  const line = rest.split("\n")[0] ?? "";
  const found = signature.exec(line);
  if (found === null) return written;
  const between = line.slice(0, found.index + found[0].length);
  if (between.includes(sandboxFilesPath) || /https?:/u.test(between)) {
    return written;
  }
  return `${written}${between}`;
}

function withExactLinksInText(text: string, known: readonly string[]) {
  let mended = "";
  let from = 0;
  for (const match of text.matchAll(looseLink)) {
    if (match.index < from) continue;
    const written = linkExtent(text, match.index, match[0]);
    const link = exactSharedLink(written, known);
    if (link === undefined) continue;
    mended += `${text.slice(from, match.index)}${link}`;
    from = match.index + written.length;
  }
  return from === 0 ? text : `${mended}${text.slice(from)}`;
}

/**
 * The send with every task file link in it, as a link, an attachment or in
 * its text, made the known link it stands for (`exactSharedLink`).
 */
export function withExactSharedLinks<M extends SentMessage>(
  message: M,
  known: readonly string[]
): M {
  if (known.length === 0) return message;
  if (message.kind === "link") {
    const url = exactSharedLink(message.url, known) ?? message.url;
    return url === message.url ? message : { ...message, url };
  }
  const text =
    message.text === undefined
      ? undefined
      : withExactLinksInText(message.text, known);
  const attachments = message.attachments?.map((attachment) => {
    const url = exactSharedLink(attachment.url, known) ?? attachment.url;
    return url === attachment.url ? attachment : { ...attachment, url };
  });
  let sent = message;
  if (text !== message.text) sent = { ...sent, text };
  if (
    attachments?.some(
      (attachment, index) => attachment !== message.attachments?.[index]
    ) === true
  ) {
    sent = { ...sent, attachments };
  }
  return sent;
}
