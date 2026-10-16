import { createHash } from "node:crypto";
import { posix } from "node:path";
import { defineState } from "eve/context";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { resolveMediaType } from "@agent/lib/inbound-media/media-type";
import { unpackZipEntries } from "@agent/lib/inbound-media/zip";
import {
  maximumSharedFileBytes,
  shareSandboxFile,
  sharedFileName,
  taskFilesShareBytes,
} from "@agent/lib/sandbox/files";
import { taskFilesOfCaller } from "@agent/lib/sandbox/pilot";

const presentationMediaType =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** What a file is by its name, when its bytes do not say (text, csv, office). */
const mediaTypesByExtension: ReadonlyMap<string, string> = new Map([
  [".csv", "text/csv"],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [".ics", "text/calendar"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".odp", "application/vnd.oasis.opendocument.presentation"],
  [".ods", "application/vnd.oasis.opendocument.spreadsheet"],
  [".odt", "application/vnd.oasis.opendocument.text"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".pptx", presentationMediaType],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain"],
  [".vcf", "text/vcard"],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [".xml", "application/xml"],
  [".zip", "application/zip"],
]);

function mediaTypeOf(name: string, bytes: Uint8Array) {
  const extension = /\.[a-z\d]{1,8}$/iu.exec(name)?.[0]?.toLowerCase();
  const byName =
    extension === undefined ? undefined : mediaTypesByExtension.get(extension);
  // The bytes say what a file is, whatever its name; the name speaks only
  // for what they do not tell, like an office document (a zip inside).
  return (
    resolveMediaType(bytes, undefined) ?? byName ?? "application/octet-stream"
  );
}

/**
 * The file's bytes, or undefined once it runs past `maximumBytes`: the read
 * stops there, so a file the sandbox grew or swapped after it was named
 * cannot fill Bro's memory.
 */
async function readWithin(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number
) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The file arrives as a sequence of chunks.
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > maximumBytes) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- The read ends here.
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
}

/**
 * The words a slide may carry, past which `brokit look` warns (`SLIDE_WORDS`
 * in sandbox/kit/brokit/look.py), as the task agent's instructions say: a
 * heading and 3–5 short points.
 */
const slideWords = 80;

/** What a deck's slides may unpack to, in all, for their words to be counted. */
const maximumSlidesBytes = 64 * 1024 * 1024;

const presentationPart = "ppt/presentation.xml";
const presentationRelationships = "ppt/_rels/presentation.xml.rels";
const slidePart = /^ppt\/slides\/slide(\d+)\.xml$/u;

/** A text run, a line break or a paragraph's end in a slide's DrawingML. */
const slideText = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\b[^>]*>|<\/a:p>/gu;

/** A character reference or a named entity in XML text. */
const xmlReference = /&(?:#x([\da-f]{1,6})|#(\d{1,7})|\w+);/giu;

/**
 * The decks `share_file` held back once for crowded slides, by the sha256
 * of their bytes, in eve's durable session state: the same bytes again go
 * out as they are (the person may have asked for full slides), and a deck
 * changed in any byte is counted anew.
 */
const heldDecks = defineState<{ readonly digests: readonly string[] }>(
  "bro.task-crowded-decks",
  () => ({ digests: [] })
);

/** How many held decks a session remembers, the latest ones. */
const maximumHeldDecks = 32;

/**
 * The words of XML text as `word_count` in look.py counts them: runs
 * between spaces with a letter or a digit in them, so bullets and dashes are
 * not words. A named entity (`&amp;`, `&lt;`…) stands for punctuation.
 */
function wordCount(xmlText: string) {
  return xmlText
    .replaceAll(
      xmlReference,
      (_reference, hex: string | undefined, decimal: string | undefined) => {
        if (hex === undefined && decimal === undefined) return "&";
        const code =
          hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);
        return code > 0x10ffff ? "&" : String.fromCodePoint(code);
      }
    )
    .split(/\s+/u)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

/**
 * The words of a slide, as python-pptx gives look its shapes' text: a
 * paragraph's runs joined as they show, a line break a space, paragraphs
 * apart. Notes, charts and diagrams are parts of their own, not counted.
 */
function slideWordCount(xml: string) {
  let words = 0;
  let paragraph = "";
  for (const [tag, text] of xml.matchAll(slideText)) {
    if (text !== undefined) {
      paragraph += text;
    } else if (tag.startsWith("<a:br")) {
      paragraph += " ";
    } else {
      words += wordCount(paragraph);
      paragraph = "";
    }
  }
  return words + wordCount(paragraph);
}

function slideNumber(part: string) {
  return Number(slidePart.exec(part)?.[1]);
}

/**
 * The deck's slide parts in the order it shows them: by the presentation's
 * slide list and its relationships, as look and python-pptx number them; by
 * their file numbers when that list names no slide of the deck.
 */
function slidesInOrder(parts: ReadonlyMap<string, Buffer>) {
  const relationships =
    parts.get(presentationRelationships)?.toString("utf8") ?? "";
  const targets = new Map(
    [...relationships.matchAll(/<Relationship\b[^>]*>/gu)].flatMap(([tag]) => {
      const id = /\bId="([^"]*)"/u.exec(tag)?.[1];
      const target = /\bTarget="([^"]*)"/u.exec(tag)?.[1];
      if (id === undefined || target === undefined) return [];
      // A target is relative to the presentation's folder, or from the root.
      const part = target.startsWith("/")
        ? target.slice(1)
        : posix.join("ppt", target);
      return [[id, part] as const];
    })
  );
  const presentation = parts.get(presentationPart)?.toString("utf8") ?? "";
  const listed = [
    ...presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]*)"/gu),
  ].flatMap(([, id]) => {
    const part = id === undefined ? undefined : targets.get(id);
    return part !== undefined && parts.has(part) && slidePart.test(part)
      ? [part]
      : [];
  });
  return listed.length > 0
    ? listed
    : [...parts.keys()]
        .filter((part) => slidePart.test(part))
        .toSorted((left, right) => slideNumber(left) - slideNumber(right));
}

/**
 * The slides of a .pptx with more than `slideWords` words, numbered as the
 * deck shows them; none for bytes that do not read as a deck, which go out
 * as they would without the count.
 */
function crowdedSlides(bytes: Uint8Array) {
  const parts = unpackZipEntries(
    bytes,
    (name) =>
      name === presentationPart ||
      name === presentationRelationships ||
      slidePart.test(name),
    maximumSlidesBytes
  );
  if (parts === undefined) return [];
  return slidesInOrder(parts).flatMap((part, index) => {
    const words = slideWordCount(parts.get(part)?.toString("utf8") ?? "");
    return words > slideWords ? [{ slide: index + 1, words }] : [];
  });
}

/**
 * Whether a crowded deck is held back now: the first time its bytes come,
 * and the hold is recorded so the next call shares it. A hold that cannot
 * be recorded is none, or the deck could never go out.
 */
function holdsBack(digest: string) {
  try {
    if (heldDecks.get().digests.includes(digest)) return false;
    heldDecks.update(({ digests }) => ({
      digests: [...digests, digest].slice(-maximumHeldDecks),
    }));
    return true;
  } catch (error) {
    console.warn("[share_file] crowded deck not held", {
      cause: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}

/**
 * Why a crowded deck did not go out. The rule is in the instructions and in
 * look's warning, yet on 16.10 the model shared slides of 112–129 words: it
 * comes again here, with the way to share the deck as it is when the person
 * wants it so.
 */
function crowdedDeckRefusal(
  name: string,
  slides: ReturnType<typeof crowdedSlides>,
  canLook: boolean
) {
  const counts = slides
    .map(({ slide, words }) => `slide ${String(slide)}: ${String(words)} words`)
    .join("; ");
  return `${name} was not shared: too much text on a slide (${counts}). A slide holds a heading and 3–5 short points, at most ${String(slideWords)} words: move the details to the speaker notes${canLook ? ", check the deck with look" : ""} and call share_file again. If the person asked for detailed slides themselves, call share_file once more on the same file: it goes out as it is.`;
}

export default defineTool({
  description:
    "Hand a finished file from the sandbox to Bro for the person: stores it and returns a link. Put every link you get, on its own line, in your final answer; Bro attaches the files to its message. Up to 10 MB per file.",
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The file name the person sees, such as «Отчёт за сентябрь.pdf». Defaults to the file's own name."
      ),
    path: z
      .string()
      .min(1)
      .describe(
        "Path of the file in the sandbox, such as /workspace/report.pdf."
      ),
  }),
  async execute({ name, path }, ctx) {
    // The files pilot sends files up to 20 MB; the description keeps saying
    // 10 MB so the tool block stays the same outside it, and the pilot's
    // instructions say 20.
    const filesPilot = taskFilesOfCaller(ctx);
    const cap = filesPilot ? taskFilesShareBytes : maximumSharedFileBytes;
    const sandbox = await ctx.getSandbox();
    const stream = await sandbox.readFile({ path });
    if (stream === null) throw new Error(`There is no file at ${path}.`);
    const bytes = await readWithin(stream, cap);
    if (bytes === undefined) {
      throw new Error(
        `The file ${path} is over ${String(cap / 1024 / 1024)} MB: compress it or split it into parts.`
      );
    }
    if (bytes.byteLength === 0) throw new Error(`The file ${path} is empty.`);
    const fileName = sharedFileName(name ?? path);
    const mediaType = mediaTypeOf(fileName, bytes);
    if (mediaType === presentationMediaType || /\.pptx$/iu.test(path)) {
      const slides = crowdedSlides(bytes);
      if (
        slides.length > 0 &&
        holdsBack(createHash("sha256").update(bytes).digest("hex"))
      ) {
        throw new Error(crowdedDeckRefusal(fileName, slides, filesPilot));
      }
    }
    const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
    const shared = await shareSandboxFile({
      bytes,
      maximumBytes: cap,
      mediaType,
      name: fileName,
      owner:
        caller?.principalType === "user"
          ? {
              sessionId: ctx.session.parent?.rootSessionId ?? ctx.session.id,
              workspaceId: scopeFromPrincipal(caller).workspaceId,
            }
          : undefined,
    });
    return {
      bytes: shared.bytes,
      mediaType: shared.mediaType,
      name: shared.name,
      url: shared.url,
    };
  },
});
