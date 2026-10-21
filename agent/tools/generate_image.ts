/**
 * Draws pictures through the direct model provider's Image API (RouterAI's
 * `/images/generations`, OpenRouter's `/images`): birthday cards, invitations,
 * stickers, memes, a pet from the person's photo placed into a scene. The
 * photos the person sent in this conversation and earlier pictures travel as
 * reference images, so «our dog on it» and «make it brighter» work.
 *
 * The resolver reads the photos from the turn's history, where a tool cannot
 * see them, and keeps only small references in the durable closure: eve's
 * sandbox path when it staged the attachment, otherwise a private stored copy
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
  errandOpensTurn,
  imageGenerationScope,
  personOpensTurn,
  pictureRequested,
} from "@agent/lib/image-artifact/generation";
import {
  collectPersonPhotos,
  describePhotos,
  maximumPhotos,
  type PersonPhoto,
  readPhoto,
} from "@agent/lib/image-artifact/photos";
import {
  readImageArtifact,
  storePrivateImage,
} from "@agent/lib/image-artifact/storage";
import { sniffMediaType } from "@agent/lib/inbound-media/media-type";
import { modelEndpoint } from "@agent/lib/model/endpoint";
import {
  failureStatus,
  reportedErrorSchema,
} from "@agent/lib/model/routerai/errors";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  findGeneratedImageArtifact,
  saveGeneratedImageArtifact,
} from "@db/services/generated-images";
import { maximumBrowserImageBytes } from "@shared/browser/artifact";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * Where each provider draws. RouterAI serves the same body, reference photos
 * in `input_references` included, on `/images/generations` (probes of 01.10:
 * Gemini 3.1 Flash Lite Image drew and edited a picture there).
 */
const imagesPath = { openrouter: "/images", routerai: "/images/generations" };
/** Image models take ten seconds to a minute; past two the turn is stuck. */
const generationTimeoutMs = 120_000;
/** The newest pictures of this conversation named in the description. */
const maximumDrawnPictures = 3;

type ModelMessage = DynamicResolveContext["messages"][number];

/**
 * The Image API's answer: the picture, or the reason there is none. RouterAI
 * reports a refusal as `{ error: "text" }`, often the upstream's whole JSON
 * answer under HTTP 200, whose `code` is the real status.
 */
const imageResponseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) })).optional(),
  error: reportedErrorSchema.nullish(),
});

export default defineDynamic({
  events: {
    async "turn.started"(_event, context) {
      const scope = imageGenerationScope(context);
      // Only a turn the person started sees the paid tool, never a browser
      // report. It stays in every such turn, so the tool block before the
      // history keeps its cache from one message to the next.
      if (
        !scope ||
        !startedByPerson(context) ||
        !personOpensTurn(context.messages)
      ) {
        return null;
      }
      // A request for a picture, a photo to work with, or an errand that may
      // need one lets it draw; a code or a bare reply does not.
      const drawingAsked =
        pictureRequested(context.messages) || errandOpensTurn(context.messages);
      const photos = await collectPersonPhotos(scope, context.messages);
      return defineTool({
        description: `Draw a new picture, or change one, and get it back as a private artifact: birthday and holiday cards, invitations, posters, stickers, memes, illustrations, a pet or a person from the person's photos placed into a scene. Put the returned markdown line, exactly as returned, into the text of one send_message call and the chat receives a real photo. To change a picture («brighter», «add a hat», «bigger letters») call again with a prompt describing the whole result and pass that picture's artifact in images; never start over from scratch for an edit. ${describeDrawnPictures(context.messages)}${describePhotos(photos)}`,
        inputSchema: z.object({
          aspectRatio: z
            .enum(["1:1", "3:4", "2:3", "9:16", "16:9", "3:2", "4:3"])
            .optional()
            .describe(
              "Shape of the picture. Default 1:1; 3:4 or 9:16 suits a phone screen, 16:9 a banner."
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
          if (!drawingAsked) {
            return {
              note: "Nothing drawn: this message asks for no picture. Draw when the person asks for one or an errand needs it.",
              status: "not_asked" as const,
            };
          }
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
  const endpoint = modelEndpoint();
  if (!caller)
    throw new Error("Drawing a picture needs an authenticated user.");
  if (!endpoint) {
    throw new Error(
      "No image model provider is configured on this deployment."
    );
  }
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
  const model = endpoint.imageModel;
  const response = await fetch(
    `${endpoint.baseURL}${imagesPath[endpoint.provider]}`,
    {
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
        authorization: `Bearer ${endpoint.apiKey}`,
        "content-type": "application/json",
        ...endpoint.headers,
      },
      method: "POST",
      signal: AbortSignal.any([
        ctx.abortSignal,
        AbortSignal.timeout(generationTimeoutMs),
      ]),
    }
  );
  const answer = parseImageResponse(await response.text());
  const error = answer?.error ?? undefined;
  if (!response.ok || error !== undefined) {
    // An error under HTTP 200 is a refusal still, with its own code.
    const status = response.ok
      ? (failureStatus(error?.code) ?? 502)
      : response.status;
    const reason = error?.message?.trim().slice(0, 300);
    // The model repeats what it reads to the person, so no failure carries
    // the provider's words: the details stay in the log.
    console.warn("[generate_image] the image model failed", {
      reason,
      status,
    });
    // Credit, key and outage failures are the owner's to fix: the person is
    // told only that it is down.
    if (
      status === 401 ||
      status === 402 ||
      status === 403 ||
      status === 429 ||
      status >= 500
    ) {
      throw new Error(
        "The image service is not available right now. Never quote a provider, a status code or an error text to the person."
      );
    }
    throw new Error(
      "The image model declined this request. Change the prompt or leave out the reference pictures if you can see why; otherwise tell the person this picture cannot be made. Never quote a provider, a status code or an error text to the person."
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
