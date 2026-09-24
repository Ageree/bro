import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { UserContent } from "ai";
import { createDataUrlFilePart } from "eve/client";
import { sniffMediaType } from "@agent/lib/inbound-media/media-type";

/**
 * Builds the message a step sends, the way a person's client would.
 *
 * Photos and files go as the web chat sends them: `data:` URL file parts next
 * to the text (`app/(authenticated)/chat/_lib/message-input.ts`). A voice
 * note goes the way Telegram and iMessage deliver one, because that is where
 * people send voice: the product's own transcription turns it into the
 * «[голосовое] …» line the model reads (`agent/lib/inbound-media`).
 */

const mediaTypeByExtension: ReadonlyMap<string, string> = new Map([
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".wav", "audio/wav"],
  [".webp", "image/webp"],
]);

export interface OutgoingFile {
  readonly mediaType?: string;
  readonly path: string;
}

async function filePart(file: OutgoingFile) {
  const bytes = new Uint8Array(await readFile(file.path));
  const mediaType =
    file.mediaType ??
    sniffMediaType(bytes) ??
    mediaTypeByExtension.get(extname(file.path).toLowerCase()) ??
    "application/octet-stream";
  return createDataUrlFilePart({
    bytes,
    filename: basename(file.path),
    mediaType,
  });
}

/**
 * The voice notes as the messenger channels hand them to the model. This
 * loads the application's environment (the transcription reads its OpenRouter
 * key and models there), so it runs only when a voice note is attached.
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
      "--voice transcribes with the application's own settings: set OPENROUTER_API_KEY, BETTER_AUTH_URL and DATABASE_URL (any valid URL; no database is opened).",
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
  const spoken = voice.length > 0 ? await voiceLines(voice) : "";
  const body = [text, spoken].filter((line) => line.length > 0).join("\n");
  if (files.length === 0) return body;
  const parts: UserContent = [];
  if (body.length > 0) parts.push({ text: body, type: "text" });
  parts.push(...(await Promise.all(files.map((file) => filePart(file)))));
  return parts;
}
