import type { UserContent } from "ai";
import { z } from "zod";
import {
  baseMediaType,
  documentBytesMatch,
  documentMediaType,
  fileDetails,
  isImageMediaType,
  sniffMediaType,
  textDocumentLooksLikeAudio,
  unsupportedArchive,
} from "./media-type";
import { fileNote } from "./turn-content";

/**
 * The names of the files a person sends from the web chat, for the files
 * pilot. eve stages each file part into the sandbox under a name that loses
 * Cyrillic, and `onMessage` cannot change the message, so the channel hands
 * the model the person's own names as a context line before the message,
 * one `[файл: …]` note per file part in the parts' order: the model pairs
 * them with the paths it sees next to the parts (`agent/lib/staged-files/`).
 * A file whose bytes are not what its name says is still staged (only the
 * channel's upload policy refuses a part), so its note says so, and Bro's
 * hook refuses a broken ZIP (`agent/hooks/task-files.ts`).
 */

const heading =
  "Файлы, приложенные к сообщению человека ниже, по порядку (имена — как их назвал человек):";
/** As many files as one message to the task agent carries. */
const maximumNotes = 20;
/** A name past this is cut: it lands in the turn's context. */
const maximumNameCodePoints = 120;

const filePartSchema = z.object({
  data: z.string(),
  filename: z.string().optional(),
  mediaType: z.string(),
  type: z.literal("file"),
});

/**
 * The bytes a part carries: a base64 `data:` URL's or raw base64 (the web
 * chat sends both); none for a link or a data URL of plain text.
 */
function partBytes(data: string) {
  if (data.startsWith("data:")) {
    const comma = data.indexOf(",");
    if (comma === -1 || !/;base64$/iu.test(data.slice(0, comma))) {
      return undefined;
    }
    return new Uint8Array(Buffer.from(data.slice(comma + 1), "base64"));
  }
  if (/^https?:/iu.test(data)) return undefined;
  return new Uint8Array(Buffer.from(data, "base64"));
}

/** One file's note: what its bytes, name and declared type say it is. */
function webFileNote(part: z.infer<typeof filePartSchema>) {
  const name = Array.from(part.filename ?? "файл")
    .slice(0, maximumNameCodePoints)
    .join("");
  const bytes = partBytes(part.data);
  const declared = baseMediaType(part.mediaType);
  const type = documentMediaType(name, declared, { archives: true });
  const sniffed =
    bytes !== undefined &&
    !(type !== undefined && textDocumentLooksLikeAudio(type, bytes))
      ? sniffMediaType(bytes)
      : undefined;
  if (isImageMediaType(sniffed) || sniffed === "application/pdf") {
    return fileNote(name, sniffed);
  }
  if (unsupportedArchive(name, declared)) {
    return fileNote(name, declared, fileDetails.archiveUnsupported);
  }
  if (type === undefined) return fileNote(name, sniffed ?? declared);
  if (bytes !== undefined && !documentBytesMatch(type, bytes)) {
    return fileNote(
      name,
      type,
      type === "application/zip"
        ? fileDetails.archiveRefused
        : fileDetails.mismatch
    );
  }
  return fileNote(name, type);
}

/**
 * The context lines that name the message's files, the heading first, or
 * none when the message carries no file part.
 */
export function webFileNotes(message: string | UserContent) {
  if (!Array.isArray(message)) return [];
  const notes = message
    .flatMap((part) => filePartSchema.safeParse(part).data ?? [])
    .slice(0, maximumNotes)
    .map((part) => webFileNote(part));
  return notes.length === 0 ? [] : [heading, ...notes];
}
