import type { DynamicResolveContext } from "eve";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { maximumBrowserImageBytes } from "@shared/browser/artifact";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  describePrivateImage,
  readPrivateImage,
  storePrivateImage,
} from "./storage";

/** The newest photos the person sent that the model may pick from. */
export const maximumPhotos = 4;
const captionLength = 80;
const sandboxScheme = "eve-sandbox:";

/** A photo from the history, reduced to what the executor needs to read it. */
export type PersonPhoto = {
  readonly caption: string;
  readonly mediaType: string;
} & (
  | { readonly path: string; readonly source: "sandbox" }
  | {
      readonly byteSize: number;
      readonly contentHash: string;
      readonly source: "blob";
      readonly storagePathname: string;
    }
);

type ModelMessage = DynamicResolveContext["messages"][number];

export function describePhotos(photos: readonly PersonPhoto[]) {
  if (photos.length === 0) {
    return "The person has sent no photos in this conversation.";
  }
  const lines = photos.map(
    (photo, index) =>
      `${String(index + 1)} — sent with «${photo.caption || "без подписи"}»`
  );
  return `Photos the person sent in this conversation, newest first: ${lines.join("; ")}.`;
}

/**
 * A photo part of a message as eve keeps it: staged in the sandbox, where the
 * data is an `eve-sandbox:?path=…&type=…` reference (a URL, or its text once
 * history went through JSON), or still inline as bytes, a data URL or bare
 * base64. A remote URL is not a photo the person sent and is left out.
 */
const photoTextSchema = z.union([
  z
    .string()
    .startsWith(sandboxScheme)
    .transform((text, check) => {
      const parameters = new URL(text).searchParams;
      const path = parameters.get("path");
      const mediaType = parameters.get("type");
      if (!path || !mediaType?.startsWith("image/")) {
        check.addIssue({ code: "custom", message: "Not a staged image." });
        return z.NEVER;
      }
      return { mediaType, path, source: "sandbox" as const };
    }),
  z
    .string()
    .regex(/^data:[^,]*;base64,/u)
    .transform((text) => inlinePhoto(text.slice(text.indexOf(",") + 1))),
  z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u)
    .transform((text) => inlinePhoto(text)),
]);
const photoDataSchema = z.union([
  z.instanceof(Uint8Array).transform((bytes) => ({
    bytes,
    source: "inline" as const,
  })),
  z.instanceof(ArrayBuffer).transform((buffer) => ({
    bytes: new Uint8Array(buffer),
    source: "inline" as const,
  })),
  z
    .instanceof(URL)
    .transform((url) => url.href)
    .pipe(photoTextSchema),
  photoTextSchema,
]);

type PhotoData = z.infer<typeof photoDataSchema>;

function inlinePhoto(base64: string) {
  return {
    bytes: new Uint8Array(Buffer.from(base64, "base64")),
    source: "inline" as const,
  };
}

/**
 * The newest photos in the person's own messages. A photo eve staged in the
 * sandbox is kept by its path, with no call to any store. A photo still
 * inline is copied into private storage once, on the turn it arrives; on later
 * turns only its content hash is recomputed to name that copy, so a turn
 * that draws nothing makes no storage calls. A photo that cannot be kept is
 * left out rather than failing the turn.
 */
export async function collectPersonPhotos(
  scope: AccessScope,
  messages: readonly ModelMessage[]
) {
  const incoming = messages.findLastIndex((message) => message.role === "user");
  const found: {
    readonly arrived: boolean;
    readonly caption: string;
    readonly data: PhotoData;
  }[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const caption = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join(" ")
      .replaceAll(/\s+/gu, " ")
      .trim()
      .slice(0, captionLength);
    for (const part of message.content) {
      const data =
        part.type === "image"
          ? part.image
          : part.type === "file" && part.mediaType.startsWith("image/")
            ? part.data
            : undefined;
      const parsed = photoDataSchema.safeParse(data);
      if (parsed.success) {
        found.push({ arrived: index === incoming, caption, data: parsed.data });
      }
    }
  }
  const photos = await Promise.all(
    found
      .toReversed()
      .slice(0, maximumPhotos)
      .map(async (photo) => keepPhoto(scope, photo).catch(() => undefined))
  );
  return photos.filter((photo) => photo !== undefined);
}

async function keepPhoto(
  scope: AccessScope,
  photo: {
    readonly arrived: boolean;
    readonly caption: string;
    readonly data: PhotoData;
  }
): Promise<PersonPhoto> {
  const { arrived, caption, data } = photo;
  if (data.source === "sandbox") return { caption, ...data };
  const stored = arrived
    ? await storePrivateImage(scope, data.bytes, "reference")
    : describePrivateImage(scope, data.bytes, "reference");
  return {
    byteSize: stored.byteSize,
    caption,
    contentHash: stored.contentHash,
    mediaType: stored.mediaType,
    source: "blob",
    storagePathname: stored.storagePathname,
  };
}

export async function readPhoto(photo: PersonPhoto, ctx: ToolContext) {
  if (photo.source === "blob") {
    return readPrivateImage(photo, ctx.abortSignal);
  }
  const sandbox = await ctx.getSandbox();
  const bytes = await sandbox.readBinaryFile({ path: photo.path });
  return bytes && bytes.byteLength <= maximumBrowserImageBytes
    ? bytes
    : undefined;
}
