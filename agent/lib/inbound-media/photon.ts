import type { Attachment, Message } from "chat";
import { z } from "zod";
import { downloadWithin } from "./download";
import {
  audioByteCap,
  baseMediaType,
  inlineImageByteCap,
  isAudioMediaType,
  isImageMediaType,
  pdfByteCap,
  resolveMediaType,
} from "./media-type";
import { transcribeAudio, transcriptionAvailable } from "./transcription";
import {
  fileNote,
  inboundTurn,
  type InboundMediaItem,
  type InboundTurn,
} from "./turn-content";

/**
 * Inbound iMessage media resolved to bytes before the turn starts. The Photon
 * adapter describes an attachment by name, type and size only; its bytes live
 * behind the `read()` of the spectrum content node on the raw message, so
 * without this the model saw either a bare URL with a guessed media type or,
 * for a photo without a caption, no turn at all.
 */

/** The bytes of one spectrum attachment or voice node. */
const readerSchema = z.function({
  input: [],
  output: z.promise(z.instanceof(Uint8Array)),
});

/**
 * The parts of a spectrum content tree that carry bytes. `reply` wraps one
 * node and `group` lists several, in the order the adapter reports them.
 */
const contentNodeSchema = z.object({
  get content() {
    return contentNodeSchema.optional();
  },
  get items() {
    return z
      .array(
        z.object({
          get content() {
            return contentNodeSchema;
          },
        })
      )
      .optional();
  },
  read: readerSchema.optional(),
  type: z.string(),
});

type ContentNode = z.infer<typeof contentNodeSchema>;

const rawMessageSchema = z.object({ content: contentNodeSchema });

function collectReaders(
  node: ContentNode,
  readers: NonNullable<ContentNode["read"]>[]
) {
  if ((node.type === "attachment" || node.type === "voice") && node.read) {
    readers.push(node.read);
  }
  if (node.content) collectReaders(node.content, readers);
  for (const item of node.items ?? []) collectReaders(item.content, readers);
  return readers;
}

/** Byte readers for the message's attachments, in attachment order. */
function rawReaders(message: Message) {
  const raw = rawMessageSchema.safeParse(message.raw);
  return raw.success ? collectReaders(raw.data.content, []) : [];
}

type AttachmentBytes =
  | {
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      readonly mediaType: string | undefined;
    }
  | { readonly kind: "oversize" }
  | { readonly kind: "failed"; readonly reason: string };

function within(bytes: Uint8Array, maxBytes: number): AttachmentBytes {
  return bytes.byteLength > maxBytes
    ? { kind: "oversize" }
    : { bytes, kind: "bytes", mediaType: undefined };
}

/**
 * Resolves an attachment's bytes from whatever the adapter provided: inline
 * data, a fetcher, the raw spectrum reader, or a public HTTPS URL.
 */
async function attachmentBytes(
  attachment: Attachment,
  reader: NonNullable<ContentNode["read"]> | undefined,
  maxBytes: number
): Promise<AttachmentBytes> {
  try {
    if (attachment.data instanceof Blob) {
      return within(
        new Uint8Array(await attachment.data.arrayBuffer()),
        maxBytes
      );
    }
    if (attachment.data) return within(attachment.data, maxBytes);
    if (attachment.fetchData) {
      return within(await attachment.fetchData(), maxBytes);
    }
    if (reader) return within(await reader(), maxBytes);
  } catch {
    return { kind: "failed", reason: "read failed" };
  }
  if (attachment.url && URL.canParse(attachment.url)) {
    return downloadWithin(new URL(attachment.url), maxBytes);
  }
  return { kind: "failed", reason: "no source" };
}

function byteCapFor(attachment: Attachment, declared: string | undefined) {
  if (isImageMediaType(declared)) return inlineImageByteCap;
  if (declared === "application/pdf") return pdfByteCap;
  if (isAudioMediaType(declared) || attachment.type === "audio") {
    return audioByteCap;
  }
  return pdfByteCap;
}

function isVoiceName(name: string | undefined) {
  return name?.toLowerCase().endsWith(".caf") === true;
}

async function attachmentItem(
  attachment: Attachment,
  reader: NonNullable<ContentNode["read"]> | undefined
): Promise<InboundMediaItem> {
  const declared = baseMediaType(attachment.mimeType);
  const voiceLike =
    attachment.type === "audio" ||
    isAudioMediaType(declared) ||
    isVoiceName(attachment.name);
  if (voiceLike && !transcriptionAvailable()) {
    return { kind: "voice-unsupported" };
  }
  const resolved = await attachmentBytes(
    attachment,
    reader,
    byteCapFor(attachment, declared)
  );
  if (resolved.kind === "oversize") {
    if (voiceLike) return { kind: "voice-failed" };
    return {
      kind: "note",
      text: fileNote(attachment.name, declared, "слишком большой"),
    };
  }
  if (resolved.kind === "failed") {
    console.warn("[inbound-media] photon attachment", {
      declaredBytes: attachment.size,
      mediaType: declared,
      status: resolved.reason,
    });
    if (voiceLike) return { kind: "voice-failed" };
    return {
      kind: "note",
      text: fileNote(attachment.name, declared, "не удалось получить"),
    };
  }
  const mediaType =
    resolveMediaType(resolved.bytes, resolved.mediaType) ?? declared;
  if (isImageMediaType(mediaType)) {
    if (resolved.bytes.byteLength > inlineImageByteCap) {
      return {
        kind: "note",
        text: fileNote(attachment.name, mediaType, "слишком большой"),
      };
    }
    console.info("[inbound-media] photon image", {
      bytes: resolved.bytes.byteLength,
      mediaType,
      status: "ok",
    });
    return {
      data: resolved.bytes,
      filename: attachment.name ?? "photo",
      kind: "image",
      mediaType,
    };
  }
  if (mediaType === "application/pdf") {
    if (resolved.bytes.byteLength > pdfByteCap) {
      return {
        kind: "note",
        text: fileNote(attachment.name, mediaType, "слишком большой"),
      };
    }
    return {
      data: resolved.bytes,
      filename: attachment.name ?? "document.pdf",
      kind: "pdf",
    };
  }
  if (voiceLike || isAudioMediaType(mediaType)) {
    if (!transcriptionAvailable()) return { kind: "voice-unsupported" };
    const transcript = await transcribeAudio({
      bytes: resolved.bytes,
      filename: attachment.name,
      mediaType: mediaType ?? declared,
    });
    return transcript.kind === "transcript"
      ? { kind: "transcript", text: transcript.text }
      : { kind: "voice-failed" };
  }
  return { kind: "note", text: fileNote(attachment.name, mediaType) };
}

/**
 * The turn for an iMessage that carries attachments, or `undefined` when it is
 * text only and eve's default turn applies.
 */
export async function photonMediaTurn(
  message: Message
): Promise<InboundTurn | undefined> {
  const attachments = message.attachments;
  if (attachments.length === 0) return undefined;
  const readers = rawReaders(message);
  const items = await Promise.all(
    attachments.map((attachment, index) =>
      attachmentItem(attachment, readers[index])
    )
  );
  return inboundTurn(message.text, items);
}
