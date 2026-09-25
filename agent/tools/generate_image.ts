/**
 * Draws pictures through OpenRouter's Image API: birthday cards, invitations,
 * stickers, memes, a pet from the person's photo placed into a scene. The
 * photos the person sent in this conversation and earlier pictures travel as
 * reference images, so «our dog on it» and «make it brighter» work.
 *
 * The resolver reads the photos from the turn's history, where a tool cannot
 * see them, and keeps only small references in the durable closure: eve's
 * sandbox path when it staged the attachment, otherwise a private Blob copy
 * made once, on the turn the photo arrived. Each drawn picture counts against
 * the workspace's monthly image quota before the paid call.
 * Nothing here logs a prompt or a picture: both can be personal.
 */

import type { DynamicResolveContext } from "eve";
import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { imageGenerationQuotaGate } from "@agent/lib/billing/quota";
import {
  artifactIdPattern,
  drawnPictures,
  imageGenerationScope,
  pictureRequested,
} from "@agent/lib/image-artifact/generation";
import {
  describePrivateImage,
  readImageArtifact,
  readPrivateImage,
  storePrivateImage,
} from "@agent/lib/image-artifact/storage";
import { sniffMediaType } from "@agent/lib/inbound-media/media-type";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  findGeneratedImageArtifact,
  saveGeneratedImageArtifact,
} from "@db/services/generated-images";
import { maximumBrowserImageBytes } from "@shared/browser/artifact";
import { env } from "@shared/environment";
import { applicationOrigin } from "@shared/environment/origin";
import type { AccessScope } from "@shared/identity/access-scope";

const imagesUrl = "https://openrouter.ai/api/v1/images";
/** Image models take ten seconds to a minute; past two the turn is stuck. */
const generationTimeoutMs = 120_000;
/** The newest photos the person sent that the model may pick from. */
const maximumPhotos = 4;
/** The newest pictures of this conversation named in the description. */
const maximumDrawnPictures = 3;
const captionLength = 80;
const sandboxScheme = "eve-sandbox:";

/** A photo from the history, reduced to what the executor needs to read it. */
type PersonPhoto = {
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

/** OpenRouter's Image API answer: the picture, or the reason there is none. */
const imageResponseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) })).optional(),
  error: z.object({ message: z.string().optional() }).nullish(),
});

export default defineDynamic({
  events: {
    async "turn.started"(_event, context) {
      const scope = imageGenerationScope(context);
      // Only the person's own request for a picture, or a photo they sent to
      // work with, puts the paid tool within reach: never a browser report,
      // a code or a question.
      if (
        !scope ||
        !startedByPerson(context) ||
        !pictureRequested(context.messages)
      ) {
        return null;
      }
      const photos = await collectPersonPhotos(scope, context.messages);
      return defineTool({
        description: `Draw a new picture, or change one, and get it back as a private artifact: birthday and holiday cards, invitations, posters, stickers, memes, illustrations, a pet or a person from the person's photos placed into a scene. Put the returned markdown line, exactly as returned, into the text of one send_message call and the chat receives a real photo. To change a picture («brighter», «add a hat», «bigger letters») call again with a prompt describing the whole result and pass that picture's artifact in images; never start over from scratch for an edit. ${describeDrawnPictures(context.messages)}${describePhotos(photos)}`,
        inputSchema: z.object({
          aspectRatio: z
            .enum(["1:1", "4:5", "3:4", "2:3", "9:16", "16:9", "3:2", "4:3"])
            .optional()
            .describe(
              "Shape of the picture. Default 1:1; 4:5 or 9:16 suits a phone screen, 16:9 a banner."
            ),
          images: z
            .array(z.string().min(1).max(200))
            .max(4)
            .optional()
            .describe(
              "Earlier pictures as /artifacts/<id>, such as one generate_image returned: pass the picture being changed, or one to match in style."
            ),
          photos: z
            .array(z.number().int().min(1).max(maximumPhotos))
            .max(maximumPhotos)
            .optional()
            .describe(
              "The person's photos to use, by number from this tool's description (1 is the newest). Whoever or whatever is on them appears in the picture."
            ),
          prompt: z
            .string()
            .trim()
            .min(1)
            .max(4000)
            .describe(
              "The whole picture to draw: subject, scene, style, colors, mood. Quote any text the picture must show exactly as it should be spelled. For an edit, describe the finished picture, not only the change."
            ),
        }),
        async execute(input, ctx) {
          return generateImage(input, ctx, photos);
        },
      });
    },
  },
});

/** The newest pictures of this conversation, so an edit passes the right one. */
function describeDrawnPictures(messages: readonly ModelMessage[]) {
  const drawn = drawnPictures(messages).slice(0, maximumDrawnPictures);
  if (drawn.length === 0) return "";
  return `Pictures drawn earlier in this conversation, newest first: ${drawn.join(", ")}; to change one, pass it in images. `;
}

function describePhotos(photos: readonly PersonPhoto[]) {
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
 * inline is copied into private Blob once, on the turn it arrives; on later
 * turns only its content hash is recomputed to name that copy, so a turn
 * that draws nothing makes no storage calls. A photo that cannot be kept is
 * left out rather than failing the turn.
 */
async function collectPersonPhotos(
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

async function generateImage(
  input: {
    readonly aspectRatio?: string;
    readonly images?: readonly string[];
    readonly photos?: readonly number[];
    readonly prompt: string;
  },
  ctx: ToolContext,
  photos: readonly PersonPhoto[]
) {
  const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
  const apiKey = env.OPENROUTER_API_KEY;
  if (!caller)
    throw new Error("Drawing a picture needs an authenticated user.");
  if (!apiKey)
    throw new Error("OpenRouter is not configured on this deployment.");
  const scope = scopeFromPrincipal(caller);
  // One call draws one picture: a replayed step finds it instead of paying
  // for a second one.
  const idempotencyKey = `${ctx.session.id}:${ctx.session.turn.id}:${ctx.callId}`;
  const drawn = await findGeneratedImageArtifact(scope, idempotencyKey);
  if (drawn) return readyImage(drawn);
  // Counted only for a call that is about to pay: a replay found above is
  // not a second picture.
  const quota = await imageGenerationQuotaGate(scope);
  if (!quota.allowed) {
    return { note: quota.note, status: "quota_exhausted" as const };
  }

  const references = await readReferences(scope, input, ctx, photos);
  const model = env.OPENROUTER_IMAGE_MODEL;
  const response = await fetch(imagesUrl, {
    body: JSON.stringify({
      aspect_ratio: input.aspectRatio,
      input_references:
        references.length > 0
          ? references.map((reference) => ({
              image_url: {
                url: `data:${reference.mediaType};base64,${Buffer.from(reference.bytes).toString("base64")}`,
              },
              type: "image_url",
            }))
          : undefined,
      model,
      n: 1,
      prompt: input.prompt,
    }),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "HTTP-Referer": applicationOrigin(),
      "X-Title": "Bro",
    },
    method: "POST",
    signal: AbortSignal.any([
      ctx.abortSignal,
      AbortSignal.timeout(generationTimeoutMs),
    ]),
  });
  const answer = parseImageResponse(await response.text());
  if (!response.ok) {
    const reason = answer?.error?.message?.trim().slice(0, 300);
    throw new Error(
      `The image model refused the request (${String(response.status)}): ${reason !== undefined && reason.length > 0 ? reason : "no details"}`
    );
  }
  const image = answer?.data?.[0];
  if (!image) {
    throw new Error(
      "The image model returned no picture; it may have declined the prompt."
    );
  }
  const stored = await storePrivateImage(
    scope,
    new Uint8Array(Buffer.from(image.b64_json, "base64")),
    "generated"
  );
  return readyImage(
    await saveGeneratedImageArtifact(scope, {
      byteSize: stored.byteSize,
      contentHash: stored.contentHash,
      filename: `picture.${stored.extension}`,
      idempotencyKey,
      mediaType: stored.mediaType,
      model,
      prompt: input.prompt,
      rootSessionId: ctx.session.id,
      storagePathname: stored.storagePathname,
    })
  );
}

/**
 * The person's photos by number, then the earlier pictures, as bytes the
 * provider receives inline. A reference that cannot be read fails the call
 * with a reason the model can act on, rather than drawing without it.
 */
async function readReferences(
  scope: AccessScope,
  input: {
    readonly images?: readonly string[];
    readonly photos?: readonly number[];
  },
  ctx: ToolContext,
  photos: readonly PersonPhoto[]
) {
  const references: { bytes: Uint8Array; mediaType: string }[] = [];
  /* oxlint-disable eslint/no-await-in-loop -- Sequential on purpose, to bound the bytes held at once. */
  for (const number of new Set(input.photos)) {
    const photo = photos[number - 1];
    if (!photo) {
      throw new Error(
        `There is no photo ${String(number)}; ${describePhotos(photos)}`
      );
    }
    const bytes = await readPhoto(photo, ctx);
    const mediaType = bytes && sniffMediaType(bytes);
    if (!bytes || !mediaType?.startsWith("image/")) {
      throw new Error(
        `Photo ${String(number)} could not be read; ask the person to send it again.`
      );
    }
    references.push({ bytes, mediaType });
  }
  for (const reference of new Set(input.images)) {
    const artifactId = artifactIdPattern.exec(reference)?.[0]?.toLowerCase();
    const image =
      artifactId &&
      (await readImageArtifact(scope, artifactId, {
        maximumBytes: maximumBrowserImageBytes,
        rootSessionId: ctx.session.id,
        signal: ctx.abortSignal,
      }));
    if (!image || !image.mediaType.startsWith("image/")) {
      throw new Error(
        `${reference} is not a picture from this conversation; pass the /artifacts/<id> a tool returned.`
      );
    }
    references.push({ bytes: image.bytes, mediaType: image.mediaType });
  }
  /* oxlint-enable eslint/no-await-in-loop */
  return references;
}

async function readPhoto(photo: PersonPhoto, ctx: ToolContext) {
  if (photo.source === "blob") {
    return readPrivateImage(photo, ctx.abortSignal);
  }
  const sandbox = await ctx.getSandbox();
  const bytes = await sandbox.readBinaryFile({ path: photo.path });
  return bytes && bytes.byteLength <= maximumBrowserImageBytes
    ? bytes
    : undefined;
}

function readyImage(artifact: { readonly id: string }) {
  const url = `/artifacts/${artifact.id}`;
  return {
    artifact: url,
    markdown: `![картинка](${url})`,
    status: "ready" as const,
  };
}

/** Reads one Image API body; an unparseable body carries no picture. */
function parseImageResponse(body: string) {
  try {
    return imageResponseSchema.parse(JSON.parse(body));
  } catch {
    return undefined;
  }
}
