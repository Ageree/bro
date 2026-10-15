import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { UserContent } from "ai";
import {
  mediaTypeForName,
  sniffMediaType,
} from "@agent/lib/inbound-media/media-type";
// oxlint-disable-next-line local-next/no-route-private-imports -- the bench sends files exactly as the web composer does, through its own transport (type-only imports, safe outside the route)
import { messageFileParts } from "@app/(authenticated)/chat/_lib/message-input";
import {
  admitFiles,
  webMessageFiles,
  type FileRefusal,
} from "@shared/chat/web-files";

/**
 * Builds the message a step sends, the way a person's client would.
 *
 * Photos and files go as the web chat sends them, through its own transport
 * (`messageFileParts`): the original bytes, as a `data:` URL only for images
 * within the thumbnails' budget, otherwise as bare base64, which eve does not
 * echo into the stream and the journal. The web chat's caps apply before
 * anything is sent. A voice note goes the way Telegram and iMessage deliver
 * one, because that is where people send voice: the product's own
 * transcription turns it into the «[голосовое] …» line the model reads
 * (`agent/lib/inbound-media`).
 */

export interface OutgoingFile {
  readonly mediaType?: string;
  readonly path: string;
}

const mebibyte = 1024 * 1024;

/** Why the web chat would not take a file, as the driver says it. */
const refusalReasons = {
  accept: "веб-чат не принимает такой тип файла",
  max_file_size: `файл больше ${String(webMessageFiles.maxFileSize / mebibyte)} МиБ — веб-чат ответит 413`,
  max_files: `больше ${String(webMessageFiles.maxFiles)} файлов в одном сообщении`,
  max_total_size: `файлы сообщения вместе больше ${String(webMessageFiles.maxTotalSize / mebibyte)} МиБ`,
} as const satisfies Readonly<Record<FileRefusal, string>>;

/**
 * The files as the web chat's file parts. The caps are checked on the
 * files' sizes first, so a message the web chat would refuse fails here
 * before any byte is read or sent.
 */
async function fileParts(files: readonly OutgoingFile[]) {
  const sized = await Promise.all(
    files.map(async (file) => ({
      file,
      name: basename(file.path),
      size: (await stat(file.path)).size,
      type: file.mediaType ?? "",
    }))
  );
  const { admitted, refusal } = admitFiles(sized, webMessageFiles);
  if (refusal !== undefined) {
    const refused = sized.find((each) => !admitted.includes(each));
    throw new Error(`${refused?.name ?? "файл"}: ${refusalReasons[refusal]}`);
  }
  const loaded = await Promise.all(
    sized.map(async ({ file, name }) => {
      const bytes = await readFile(file.path);
      const mediaType =
        file.mediaType ??
        sniffMediaType(new Uint8Array(bytes)) ??
        mediaTypeForName(name) ??
        "application/octet-stream";
      return {
        filename: name,
        mediaType,
        url: `data:${mediaType};base64,${bytes.toString("base64")}`,
      };
    })
  );
  return messageFileParts(loaded);
}

/**
 * The voice notes as the messenger channels hand them to the model. This
 * loads the application's environment (the transcription reads its model
 * provider's key and models there), so it runs only when a voice note is attached.
 */
async function voiceLines(paths: readonly string[]) {
  let modules;
  try {
    modules = await Promise.all([
      import("@agent/lib/inbound-media/transcription"),
      import("@agent/lib/inbound-media/turn-content"),
    ]);
  } catch (error) {
    throw new Error(
      "--voice transcribes with the application's own settings: set OPENROUTER_API_KEY (or MODEL_PROVIDER=routerai with ROUTERAI_API_KEY), BETTER_AUTH_URL and DATABASE_URL (any valid URL; no database is opened).",
      { cause: error }
    );
  }
  const [{ transcribeAudio }, { inboundTurn }] = modules;
  const items = await Promise.all(
    paths.map(async (path) => {
      const transcription = await transcribeAudio({
        bytes: new Uint8Array(await readFile(path)),
        filename: basename(path),
      });
      if (transcription.kind === "failed") {
        throw new Error(
          `Voice note ${path} was not transcribed: ${transcription.reason}`
        );
      }
      return { kind: "transcript" as const, text: transcription.text };
    })
  );
  // Transcripts alone always make a plain-text turn.
  const { message } = inboundTurn("", items);
  return message === undefined || Array.isArray(message) ? "" : message;
}

/** The `message` for `sessions.create` or `session.send`. */
export async function messageContent(
  text: string,
  files: readonly OutgoingFile[],
  voice: readonly string[]
): Promise<string | UserContent> {
  const attached = files.length > 0 ? await fileParts(files) : [];
  const spoken = voice.length > 0 ? await voiceLines(voice) : "";
  const body = [text, spoken].filter((line) => line.length > 0).join("\n");
  if (attached.length === 0) return body;
  const parts: UserContent = [];
  if (body.length > 0) parts.push({ text: body, type: "text" });
  parts.push(...attached);
  return parts;
}
