/**
 * Makes short clips through the direct model provider's Video API
 * (RouterAI's `/videos`): a scene from words, or the person's photo or a
 * picture Bro drew brought to life as the first frame. Only in the pilot
 * VIDEO_WORKSPACES, and only in a turn where the person asked for a clip:
 * one costs about ten roubles.
 *
 * The API is asynchronous: the call is queued, polled until done, and the
 * clip is read back with the key. It is kept in private object storage as
 * an `/artifacts/<id>` like a drawn picture, so the channels send it as a
 * video. Each clip counts against the workspace's monthly picture quota.
 * Nothing here logs a prompt or a clip: both can be personal.
 */

import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { z } from "zod";
import { imageGenerationQuotaGate } from "@agent/lib/billing/quota";
import {
  artifactIdPattern,
  imageGenerationScope,
  videoRequested,
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
  storeGeneratedVideo,
} from "@agent/lib/image-artifact/storage";
import { sniffMediaType } from "@agent/lib/inbound-media/media-type";
import { modelEndpoint } from "@agent/lib/model/endpoint";
import {
  failureStatus,
  reportedErrorSchema,
} from "@agent/lib/model/routerai/errors";
import { startedByPerson } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { listsWorkspaceRemembered } from "@agent/lib/workspace-list";
import {
  findGeneratedImageArtifact,
  saveGeneratedImageArtifact,
} from "@db/services/generated-images";
import { maximumBrowserImageBytes } from "@shared/browser/artifact";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";

/**
 * Five seconds took 18–35 s on 14.10, Wan 2.6 three minutes; past four the
 * turn has waited long enough.
 */
const generationTimeoutMs = 240_000;
const pollIntervalMs = 5000;
/** HeyGen Video 1 makes 5 to 15 seconds; longer costs more than it adds. */
const durations = { maximum: 10, minimum: 5 } as const;

/** What the Video API calls a job still being made. */
const pendingStatuses = new Set([
  "in_progress",
  "pending",
  "processing",
  "queued",
]);

/** The queued job, or the reason there is none. */
const jobSchema = z.object({
  error: reportedErrorSchema.nullish(),
  id: z.string().optional(),
  polling_url: z.url().optional(),
  status: z.string().optional(),
  unsigned_urls: z.array(z.url()).optional(),
});

export default defineDynamic({
  events: {
    async "turn.started"(_event, context) {
      const scope = imageGenerationScope(context);
      // Only the person's own request for a clip puts the paid tool within
      // reach: never a browser report, a code or a question.
      if (
        !scope ||
        modelEndpoint()?.videoModel === undefined ||
        !startedByPerson(context) ||
        !videoRequested(context.messages) ||
        !(await videoPilot(scope))
      ) {
        return null;
      }
      const photos = await collectPersonPhotos(scope, context.messages);
      return defineTool({
        description: `Make a short video clip, about ten roubles each, and get it back as a private artifact: a scene described in words, or a photo of the person's or a picture drawn earlier brought to life as the clip's first frame («оживи фото»). It comes with sound. Put the returned markdown line, exactly as returned, into the text of one send_message call and the chat receives a real video. Making one takes up to a minute; tell the person first. ${describePhotos(photos)}`,
        inputSchema: z.object({
          aspectRatio: z
            .enum(["16:9", "9:16", "1:1", "4:3", "3:4"])
            .optional()
            .describe(
              "Shape of the clip. Default 16:9; 9:16 suits a phone screen or a story, 1:1 a post. With a first frame, match its shape."
            ),
          durationSeconds: z
            .number()
            .int()
            .min(durations.minimum)
            .max(durations.maximum)
            .optional()
            .describe("Length in seconds; default 5. Longer costs more."),
          image: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe(
              "An earlier picture as /artifacts/<id>, such as one generate_image returned, to bring to life as the first frame."
            ),
          photo: z
            .number()
            .int()
            .min(1)
            .max(maximumPhotos)
            .optional()
            .describe(
              "The person's photo to bring to life as the first frame, by number from this tool's description (1 is the newest)."
            ),
          prompt: z
            .string()
            .trim()
            .min(1)
            .max(2000)
            .describe(
              "What happens in the clip: subject, action, camera, setting, mood. With a first frame, describe the motion from it."
            ),
        }),
        async execute(input, ctx) {
          return generateVideo(input, ctx, photos);
        },
      });
    },
  },
});

/** Whether the workspace is in VIDEO_WORKSPACES, by id or owner's email or `*`. */
async function videoPilot(scope: AccessScope) {
  const list = env.VIDEO_WORKSPACES ?? [];
  if (list.length === 0) return false;
  if (list.includes("*")) return true;
  try {
    return await listsWorkspaceRemembered(list, scope);
  } catch (error) {
    console.warn("[generate_video] pilot lookup failed", { cause: error });
    return false;
  }
}

async function generateVideo(
  input: {
    readonly aspectRatio?: string;
    readonly durationSeconds?: number;
    readonly image?: string;
    readonly photo?: number;
    readonly prompt: string;
  },
  ctx: ToolContext,
  photos: readonly PersonPhoto[]
) {
  const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
  const endpoint = modelEndpoint();
  const model = endpoint?.videoModel;
  if (!caller) throw new Error("Making a video needs an authenticated user.");
  if (!endpoint || model === undefined) {
    throw new Error(
      "No video model provider is configured on this deployment."
    );
  }
  const scope = scopeFromPrincipal(caller);
  // One call makes one clip: a replayed step finds it instead of paying for
  // a second. A step replayed while its clip was still being made pays
  // again: the job is not recorded until it is done.
  const idempotencyKey = `${ctx.session.id}:${ctx.session.turn.id}:${ctx.callId}`;
  const made = await findGeneratedImageArtifact(scope, idempotencyKey);
  if (made) return readyVideo(made);
  const quota = await imageGenerationQuotaGate(scope);
  if (!quota.allowed) {
    return { note: quota.note, status: "quota_exhausted" as const };
  }

  const firstFrame = await readFirstFrame(scope, input, ctx, photos);
  const signal = AbortSignal.any([
    ctx.abortSignal,
    AbortSignal.timeout(generationTimeoutMs),
  ]);
  const headers = {
    authorization: `Bearer ${endpoint.apiKey}`,
    "content-type": "application/json",
    ...endpoint.headers,
  };
  const queued = await fetch(`${endpoint.baseURL}/videos`, {
    body: JSON.stringify({
      aspect_ratio: input.aspectRatio ?? "16:9",
      duration: input.durationSeconds ?? durations.minimum,
      frame_images:
        firstFrame === undefined
          ? undefined
          : [
              {
                frame_type: "first_frame",
                image_url: {
                  url: `data:${firstFrame.mediaType};base64,${Buffer.from(firstFrame.bytes).toString("base64")}`,
                },
                type: "image_url",
              },
            ],
      model,
      prompt: input.prompt,
    }),
    headers,
    method: "POST",
    signal,
  });
  let job = await readJob(queued);
  /* oxlint-disable eslint/no-await-in-loop -- Polling waits for each answer. */
  while (pendingStatuses.has(job.status ?? "")) {
    const pollingUrl = ownUrl(job.polling_url, endpoint.baseURL);
    if (pollingUrl === undefined) break;
    await pause(pollIntervalMs, signal);
    job = await readJob(
      await fetch(pollingUrl, { headers, method: "GET", signal })
    );
  }
  /* oxlint-enable eslint/no-await-in-loop */
  const clipUrl =
    job.status === "completed"
      ? ownUrl(job.unsigned_urls?.[0], endpoint.baseURL)
      : undefined;
  if (clipUrl === undefined) {
    console.warn("[generate_video] the video model made no clip", {
      status: job.status,
    });
    throw new Error(
      "The video model made no clip; it may have declined the prompt. Never quote a provider or an error text to the person."
    );
  }
  const clip = await fetch(clipUrl, { headers, method: "GET", signal });
  if (!clip.ok) {
    console.warn("[generate_video] the clip could not be read", {
      status: clip.status,
    });
    throw new Error("The video service is not available right now.");
  }
  const stored = await storeGeneratedVideo(
    scope,
    new Uint8Array(await clip.arrayBuffer())
  );
  return readyVideo(
    await saveGeneratedImageArtifact(scope, {
      byteSize: stored.byteSize,
      contentHash: stored.contentHash,
      filename: "video.mp4",
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
 * The job an answer of the Video API describes. A refusal comes as an
 * `error`, under its HTTP status or under 200 with its own code; credit,
 * key and outage failures are the owner's to fix, and the model repeats
 * what it reads to the person: they are told only that it is down.
 */
async function readJob(response: Response) {
  const text = await response.text();
  let job: z.infer<typeof jobSchema> | undefined;
  try {
    job = jobSchema.parse(JSON.parse(text));
  } catch {
    job = undefined;
  }
  const error = job?.error ?? undefined;
  if (response.ok && job !== undefined && error === undefined) return job;
  const status = response.ok
    ? (failureStatus(error?.code) ?? 502)
    : response.status;
  const reason = error?.message?.trim().slice(0, 300);
  if (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 429 ||
    status >= 500
  ) {
    console.warn("[generate_video] the video model failed", { reason, status });
    throw new Error(
      "The video service is not available right now. Never quote a provider, a status code or an error text to the person."
    );
  }
  throw new Error(
    `The video model refused the request (${String(status)}): ${reason !== undefined && reason.length > 0 ? reason : "no details"}`
  );
}

/**
 * The first frame: the person's photo by number, or an earlier picture. One
 * that cannot be read fails the call with a reason the model can act on,
 * rather than making a clip without it.
 */
async function readFirstFrame(
  scope: AccessScope,
  input: { readonly image?: string; readonly photo?: number },
  ctx: ToolContext,
  photos: readonly PersonPhoto[]
) {
  if (input.photo !== undefined) {
    const photo = photos[input.photo - 1];
    if (!photo) {
      throw new Error(
        `There is no photo ${String(input.photo)}; ${describePhotos(photos)}`
      );
    }
    const bytes = await readPhoto(photo, ctx);
    const mediaType = bytes && sniffMediaType(bytes);
    if (!bytes || !mediaType?.startsWith("image/")) {
      throw new Error(
        `Photo ${String(input.photo)} could not be read; ask the person to send it again.`
      );
    }
    return { bytes, mediaType };
  }
  if (input.image === undefined) return undefined;
  const artifactId = artifactIdPattern.exec(input.image)?.[0]?.toLowerCase();
  const image =
    artifactId &&
    (await readImageArtifact(scope, artifactId, {
      maximumBytes: maximumBrowserImageBytes,
      rootSessionId: ctx.session.id,
      signal: ctx.abortSignal,
    }));
  if (!image || !image.mediaType.startsWith("image/")) {
    throw new Error(
      `${input.image} is not a picture from this conversation; pass the /artifacts/<id> a tool returned.`
    );
  }
  return { bytes: image.bytes, mediaType: image.mediaType };
}

/**
 * A URL of the job's own API, or nothing: the key goes with every poll and
 * download, so it never goes to a host the answer named elsewhere.
 */
function ownUrl(url: string | undefined, baseURL: string) {
  const parsed = url === undefined ? undefined : URL.parse(url);
  return parsed?.origin === new URL(baseURL).origin ? parsed.href : undefined;
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    function stop() {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
    signal.addEventListener("abort", stop, { once: true });
  });
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The clip was not made in time.");
}

function readyVideo(artifact: { readonly id: string }) {
  const url = `/artifacts/${artifact.id}`;
  return {
    artifact: url,
    markdown: `![видео](${url})`,
    status: "ready" as const,
  };
}
