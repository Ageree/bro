import type { FilePart, UserContent } from "ai";

/**
 * What one inbound attachment became once its bytes were resolved. The channel
 * collects these next to the message text and hands them to {@link inboundTurn}.
 */
export type InboundMediaItem =
  | {
      readonly kind: "image";
      readonly data: Uint8Array;
      readonly filename: string;
      readonly mediaType: string;
    }
  | {
      readonly kind: "pdf";
      readonly data: Uint8Array;
      readonly filename: string;
    }
  | { readonly kind: "transcript"; readonly text: string }
  | { readonly kind: "voice-failed" }
  | { readonly kind: "voice-unsupported" }
  | { readonly kind: "note"; readonly text: string };

/** What the channel does with an inbound message once its media is resolved. */
export interface InboundTurn {
  /** The turn message for the model, or nothing when there is nothing to answer. */
  readonly message: string | UserContent | undefined;
  /** A one-line reply the channel sends itself, before or instead of the turn. */
  readonly notice: string | undefined;
}

/** Sent when every voice note failed to transcribe and nothing else was said. */
export const voiceRetryText =
  "Не расслышал голосовое. Напиши текстом, пожалуйста, или запиши ещё раз.";

/** Sent when the deployment has no transcription provider. */
export const voiceUnsupportedText =
  "Голосовые на этом сервере не поддерживаются. Напиши текстом, пожалуйста.";

/** Prefix of a transcript line; the instructions explain it to the model. */
const transcriptMarker = "[голосовое]";

const voiceFailedNote = "[голосовое не распозналось]";
const photoNote = "[фото]";
const documentNote = "[документ]";

/** The line the model sees for a file it cannot open. */
export function fileNote(
  name: string | undefined,
  mediaType: string | undefined,
  detail?: string
) {
  const label = `${name ?? "без имени"} (${mediaType ?? "неизвестный тип"})`;
  return detail ? `[файл: ${label}, ${detail}]` : `[файл: ${label}]`;
}

/**
 * Assembles the turn message from the text and the resolved media. The text
 * part is never empty when a file part is present, so the model knows a
 * picture or a document is attached even without a caption.
 */
export function inboundTurn(
  text: string,
  items: readonly InboundMediaItem[]
): InboundTurn {
  const lines: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length > 0) lines.push(trimmed);
  const files: FilePart[] = [];
  let voiceFailed = 0;
  let voiceUnsupported = false;
  let hasImage = false;

  for (const item of items) {
    switch (item.kind) {
      case "image": {
        hasImage = true;
        files.push({
          data: item.data,
          filename: item.filename,
          mediaType: item.mediaType,
          type: "file",
        });
        break;
      }
      case "pdf": {
        files.push({
          data: item.data,
          filename: item.filename,
          mediaType: "application/pdf",
          type: "file",
        });
        break;
      }
      case "transcript": {
        lines.push(`${transcriptMarker} ${item.text.trim()}`);
        break;
      }
      case "note": {
        lines.push(item.text);
        break;
      }
      case "voice-failed": {
        voiceFailed += 1;
        break;
      }
      case "voice-unsupported": {
        voiceUnsupported = true;
        break;
      }
    }
  }

  const notice = voiceUnsupported ? voiceUnsupportedText : undefined;
  if (voiceFailed > 0) {
    if (lines.length === 0 && files.length === 0) {
      return { message: undefined, notice: notice ?? voiceRetryText };
    }
    lines.push(voiceFailedNote);
  }
  if (lines.length === 0 && files.length > 0) {
    lines.push(hasImage ? photoNote : documentNote);
  }
  if (files.length === 0) {
    const message = lines.length > 0 ? lines.join("\n") : undefined;
    return { message, notice };
  }
  const message: UserContent = [
    { text: lines.join("\n"), type: "text" },
    ...files,
  ];
  return { message, notice };
}
