import type { DynamicResolveContext } from "eve";
import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { imageGenerationQuotaGate } from "@agent/lib/billing/quota";
import type { readReadyArtifact } from "@db/services/artifacts";
import type {
  openArtifactObject,
  putArtifactObject,
} from "@shared/object-storage/artifacts";
import type {
  findGeneratedImageArtifact,
  saveGeneratedImageArtifact,
} from "@db/services/generated-images";

const mocks = vi.hoisted(() => ({
  find: vi.fn<typeof findGeneratedImageArtifact>(),
  get: vi.fn<typeof openArtifactObject>(),
  put: vi.fn<typeof putArtifactObject>(),
  quota: vi.fn<typeof imageGenerationQuotaGate>(),
  readArtifact: vi.fn<typeof readReadyArtifact>(),
  save: vi.fn<typeof saveGeneratedImageArtifact>(),
}));

vi.mock("@shared/object-storage/artifacts", () => ({
  artifactStorageConfigured: () => true,
  openArtifactObject: mocks.get,
  putArtifactObject: mocks.put,
}));
vi.mock("@agent/lib/billing/quota", () => ({
  imageGenerationQuotaGate: mocks.quota,
}));
vi.mock("@db/services/generated-images", () => ({
  findGeneratedImageArtifact: mocks.find,
  saveGeneratedImageArtifact: mocks.save,
}));
vi.mock("@db/services/artifacts", () => ({
  readReadyArtifact: mocks.readArtifact,
}));

const requestBodySchema = z.object({
  aspect_ratio: z.string(),
  duration: z.number(),
  frame_images: z
    .array(
      z.object({
        frame_type: z.literal("first_frame"),
        image_url: z.object({ url: z.string() }),
        type: z.literal("image_url"),
      })
    )
    .optional(),
  model: z.string(),
  prompt: z.string(),
});

const fetchMock =
  vi.fn<
    (
      url: string,
      init: { body?: string; headers: Record<string, string> }
    ) => Promise<Response>
  >();

const api = "https://routerai.test/api/v1";
const jobUrl = `${api}/videos/gen-vid-1`;
const clipUrl = `${jobUrl}/content?index=0`;
/** The start of an MP4: a box size, then `ftyp`. */
const clip = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]);
const photo = new Uint8Array(32).fill(7);
photo.set([0xff, 0xd8, 0xff, 0xe0]);
const madeId = "5b0c7f84-6b6b-4f2c-9d53-0d5ad4b7f001";
const scope = { userId: "user-1", workspaceId: "personal:workspace" };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("MODEL_PROVIDER", "routerai");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("ROUTERAI_API_KEY", "routerai-test-key");
  vi.stubEnv("ROUTERAI_BASE_URL", api);
  vi.stubEnv("ROUTERAI_VIDEO_MODEL", "test/video-model");
  vi.stubEnv("VIDEO_WORKSPACES", "*");
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fetchMock.mockReset();
  fetchMock
    .mockResolvedValueOnce(
      Response.json(
        { id: "gen-vid-1", polling_url: jobUrl, status: "pending" },
        { status: 202 }
      )
    )
    .mockResolvedValueOnce(
      Response.json({
        id: "gen-vid-1",
        polling_url: jobUrl,
        status: "completed",
        unsigned_urls: [clipUrl],
        usage: { cost: 9.81 },
      })
    )
    .mockResolvedValueOnce(new Response(clip));
  mocks.find.mockResolvedValue(undefined);
  mocks.quota.mockResolvedValue({ allowed: true, note: undefined });
  mocks.put.mockResolvedValue(undefined);
  mocks.save.mockImplementation(async (_scope, artifact) => ({
    ...artifact,
    createdAt: new Date(),
    createdByUserId: scope.userId,
    id: madeId,
    workspaceId: scope.workspaceId,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("generate_video", () => {
  it("is offered only when the person asks for a clip, inside the pilot", async () => {
    expect(
      await resolve(dynamicContext([personText("нарисуй открытку")]))
    ).toBeNull();
    expect(
      await resolve(dynamicContext([personText("сделай видео с котом")]))
    ).not.toBeNull();

    vi.stubEnv("VIDEO_WORKSPACES", "");
    vi.resetModules();
    expect(
      await resolve(dynamicContext([personText("сделай видео с котом")]))
    ).toBeNull();
  });

  it("queues a clip, waits for it and keeps it as a video artifact", async () => {
    const tool = await resolveTool(
      dynamicContext([personText("сделай видео: кот идёт по пляжу")])
    );

    const result = await settle(
      execute(tool, { prompt: "Кот идёт по пляжу", aspectRatio: "9:16" })
    );

    expect(result).toEqual({
      artifact: `/artifacts/${madeId}`,
      markdown: `![видео](/artifacts/${madeId})`,
      status: "ready",
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${api}/videos`);
    expect(requestBodySchema.parse(JSON.parse(init?.body ?? ""))).toEqual({
      aspect_ratio: "9:16",
      duration: 5,
      model: "test/video-model",
      prompt: "Кот идёт по пляжу",
    });
    expect(fetchMock.mock.calls.map(([called]) => called)).toEqual([
      `${api}/videos`,
      jobUrl,
      clipUrl,
    ]);
    expect(mocks.put).toHaveBeenCalledWith(
      expect.objectContaining({ mediaType: "video/mp4" })
    );
    expect(mocks.save).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        filename: "video.mp4",
        idempotencyKey: "session-1:turn-1:call-1",
        mediaType: "video/mp4",
        model: "test/video-model",
      })
    );
  });

  it("brings the person's photo to life as the first frame", async () => {
    // The photo arrived inline: it is kept, then read back for the call.
    mocks.get.mockImplementation(async () => ({
      contentType: "image/jpeg",
      etag: '"etag"',
      size: photo.byteLength,
      status: 200 as const,
      stream: new Response(photo).body ?? new ReadableStream(),
    }));
    const tool = await resolveTool(
      dynamicContext([
        {
          content: [
            { text: "оживи это фото", type: "text" as const },
            {
              data: `data:image/jpeg;base64,${Buffer.from(photo).toString("base64")}`,
              mediaType: "image/jpeg",
              type: "file" as const,
            },
          ],
          role: "user" as const,
        },
      ])
    );

    await settle(execute(tool, { photo: 1, prompt: "Кот машет лапой" }));

    const body = requestBodySchema.parse(
      JSON.parse(fetchMock.mock.calls[0]?.[1].body ?? "")
    );
    expect(body.frame_images).toEqual([
      {
        frame_type: "first_frame",
        image_url: {
          url: `data:image/jpeg;base64,${Buffer.from(photo).toString("base64")}`,
        },
        type: "image_url",
      },
    ]);
  });

  it("never sends the key to a host the answer names elsewhere", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          id: "gen-vid-1",
          polling_url: "https://elsewhere.example/poll",
          status: "pending",
        },
        { status: 202 }
      )
    );
    const tool = await resolveTool(
      dynamicContext([personText("сделай видео с котом")])
    );

    await expect(settle(execute(tool, { prompt: "Кот" }))).rejects.toThrow(
      "The video model made no clip"
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("hands a replayed step the clip it already made", async () => {
    mocks.find.mockResolvedValueOnce({
      byteSize: clip.byteLength,
      contentHash: "hash",
      createdAt: new Date(),
      createdByUserId: scope.userId,
      filename: "video.mp4",
      id: madeId,
      idempotencyKey: "session-1:turn-1:call-1",
      mediaType: "video/mp4",
      model: "test/video-model",
      prompt: "Кот",
      rootSessionId: "session-1",
      storagePathname: "generated-videos/user-1/hash",
      workspaceId: scope.workspaceId,
    });
    const tool = await resolveTool(
      dynamicContext([personText("сделай видео с котом")])
    );

    await expect(execute(tool, { prompt: "Кот" })).resolves.toMatchObject({
      artifact: `/artifacts/${madeId}`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
  });

  it("tells the person only that the service is down when credit runs out", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: { code: 402, message: "Insufficient balance" } },
        { status: 402 }
      )
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tool = await resolveTool(
      dynamicContext([personText("сделай видео с котом")])
    );

    await expect(execute(tool, { prompt: "Кот" })).rejects.toThrow(
      "The video service is not available right now."
    );
  });
});

/** Runs a call through its polling pauses. */
async function settle<T>(promise: Promise<T>) {
  // Handled here so a rejection while the timers run is not unhandled; the
  // caller still awaits the same promise.
  promise.catch(() => undefined);
  await vi.runAllTimersAsync();
  return promise;
}

async function resolve(context: DynamicResolveContext) {
  const definition = (await import("@agent/tools/generate_video")).default;
  const handler = definition.events["turn.started"];
  if (!handler) throw new Error("generate_video resolves on turn.started.");
  return handler({}, context);
}

async function resolveTool(context: DynamicResolveContext) {
  const tool = await resolve(context);
  if (!tool || !("execute" in tool)) {
    throw new Error("generate_video resolves to a single tool.");
  }
  return tool;
}

type ResolvedTool = Awaited<ReturnType<typeof resolveTool>>;

async function execute(
  tool: ResolvedTool,
  input: Parameters<ResolvedTool["execute"]>[0]
) {
  const result = await tool.execute(input, toolContext());
  if (Symbol.asyncIterator in result) {
    throw new Error("generate_video returns one result, not a stream.");
  }
  return result;
}

function personText(text: string) {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

function dynamicContext(messages: DynamicResolveContext["messages"]) {
  return {
    channel: { kind: "channel:photon", metadata: {} },
    messages,
    model: null,
    session: {
      auth: {
        current: {
          attributes: { workspaceId: scope.workspaceId },
          authenticator: "photon-imessage",
          principalId: scope.userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}

function toolContext() {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    async getToken() {
      throw new Error("Token access is outside this focused test.");
    },
    requireAuth() {
      throw new Error("Authorization is outside this focused test.");
    },
    session: {
      auth: {
        current: {
          attributes: { workspaceId: scope.workspaceId },
          authenticator: "photon-imessage",
          principalId: scope.userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "generate_video",
  } satisfies ToolContext;
}
