import { createHash } from "node:crypto";
import type { DynamicResolveContext } from "eve";
import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as Blob from "@vercel/blob";
import type { imageGenerationQuotaGate } from "@agent/lib/billing/quota";
import type { readReadyArtifact } from "@db/services/artifacts";
import type {
  findGeneratedImageArtifact,
  saveGeneratedImageArtifact,
} from "@db/services/generated-images";

const mocks = vi.hoisted(() => ({
  find: vi.fn<typeof findGeneratedImageArtifact>(),
  get: vi.fn<typeof Blob.get>(),
  put: vi.fn<typeof Blob.put>(),
  quota: vi.fn<typeof imageGenerationQuotaGate>(),
  readArtifact: vi.fn<typeof readReadyArtifact>(),
  save: vi.fn<typeof saveGeneratedImageArtifact>(),
}));

vi.mock("@vercel/blob", async (importOriginal) => ({
  ...(await importOriginal<typeof Blob>()),
  get: mocks.get,
  put: mocks.put,
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

/** The OpenRouter Image API request this tool is expected to send. */
const requestBodySchema = z.object({
  aspect_ratio: z.string().optional(),
  input_references: z
    .array(
      z.object({
        image_url: z.object({ url: z.string() }),
        type: z.literal("image_url"),
      })
    )
    .optional(),
  model: z.string(),
  n: z.number(),
  prompt: z.string(),
});

const fetchMock =
  vi.fn<
    (
      url: string,
      init: { body: string; headers: Record<string, string> }
    ) => Promise<Response>
  >();

const dogPhoto = image([0xff, 0xd8, 0xff, 0xe0], 32);
const drawnPicture = image(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  48
);
const earlierPicture = image(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  24
);
const drawnId = "5b0c7f84-6b6b-4f2c-9d53-0d5ad4b7f001";
const earlierId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
const scope = { userId: "user-1", workspaceId: "personal:workspace" };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
  vi.stubEnv("OPENROUTER_IMAGE_MODEL", "test/image-model");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    Response.json({
      data: [
        {
          b64_json: Buffer.from(drawnPicture).toString("base64"),
          media_type: "image/png",
        },
      ],
    })
  );
  mocks.find.mockResolvedValue(undefined);
  mocks.quota.mockResolvedValue({ allowed: true, note: undefined });
  mocks.put.mockImplementation(async (pathname) => ({
    contentDisposition: "",
    contentType: "image/png",
    downloadUrl: `https://blob.example/${pathname}`,
    etag: '"etag"',
    pathname,
    url: `https://blob.example/${pathname}`,
  }));
  mocks.save.mockImplementation(async (_scope, artifact) => ({
    ...artifact,
    createdAt: new Date(),
    createdByUserId: scope.userId,
    id: drawnId,
    workspaceId: scope.workspaceId,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generate_image", () => {
  it("is offered only to interactive turns on a deployment with OpenRouter", async () => {
    expect(await resolve(dynamicContext([], "scheduled-worker"))).toBeNull();

    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.resetModules();
    expect(await resolve(dynamicContext([]))).toBeNull();
  });

  it("tells the model when there are no photos to draw from", async () => {
    const tool = await resolveTool(dynamicContext([]));

    expect(tool.description).toContain(
      "The person has sent no photos in this conversation."
    );
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("lists the person's photos newest first and copies only the one that just arrived", async () => {
    const tool = await resolveTool(
      dynamicContext([
        photoMessage(
          "старое фото",
          Buffer.from(earlierPicture).toString("base64")
        ),
        { content: "а теперь открытку", role: "assistant" },
        photoMessage(
          "вот наш пёс Бублик",
          `data:image/jpeg;base64,${Buffer.from(dogPhoto).toString("base64")}`
        ),
      ])
    );

    expect(tool.description).toContain(
      "1 — sent with «вот наш пёс Бублик»; 2 — sent with «старое фото»"
    );
    // The older photo was copied on the turn it arrived; only the new one is.
    expect(mocks.put).toHaveBeenCalledOnce();
    expect(mocks.put.mock.calls[0]?.[0]).toBe(
      `reference-photos/user-1/${sha256(dogPhoto)}`
    );
    expect(mocks.put.mock.calls[0]?.[2]).toMatchObject({ access: "private" });
  });

  it("draws with the person's photo as a reference and stores the picture as an artifact", async () => {
    mocks.get.mockResolvedValue(blobResult(dogPhoto, "image/jpeg"));
    const tool = await resolveTool(
      dynamicContext([
        photoMessage("вот наш пёс", Buffer.from(dogPhoto).toString("base64")),
      ])
    );

    const result = await execute(tool, {
      aspectRatio: "4:5",
      photos: [1],
      prompt:
        'Birthday card for Sam with the dog in a party hat, text "С днём рождения, Сэм!"',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://openrouter.ai/api/v1/images");
    expect(init?.headers.authorization).toBe("Bearer openrouter-test-key");
    const body = requestBodySchema.parse(JSON.parse(init?.body ?? "{}"));
    expect(body).toMatchObject({
      aspect_ratio: "4:5",
      model: "test/image-model",
      n: 1,
    });
    expect(body.prompt).toContain("С днём рождения, Сэм!");
    expect(body.input_references).toEqual([
      {
        image_url: {
          url: `data:image/jpeg;base64,${Buffer.from(dogPhoto).toString("base64")}`,
        },
        type: "image_url",
      },
    ]);

    const storedPicture = mocks.put.mock.calls.at(-1);
    expect(storedPicture?.[0]).toBe(
      `generated-images/user-1/${sha256(drawnPicture)}`
    );
    expect(storedPicture?.[2]).toMatchObject({
      access: "private",
      contentType: "image/png",
    });
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.save.mock.calls[0]?.[0]).toEqual(scope);
    expect(mocks.save.mock.calls[0]?.[1]).toEqual({
      byteSize: drawnPicture.byteLength,
      contentHash: sha256(drawnPicture),
      filename: "picture.png",
      idempotencyKey: "session-1:turn-1:call-1",
      mediaType: "image/png",
      model: "test/image-model",
      prompt:
        'Birthday card for Sam with the dog in a party hat, text "С днём рождения, Сэм!"',
      rootSessionId: "session-1",
      storagePathname: `generated-images/user-1/${sha256(drawnPicture)}`,
    });
    expect(result).toEqual({
      artifact: `/artifacts/${drawnId}`,
      markdown: `![картинка](/artifacts/${drawnId})`,
      status: "ready",
    });
  });

  it("reads a photo eve staged in the sandbox by its path", async () => {
    const readBinaryFile = vi.fn<SandboxSession["readBinaryFile"]>(
      async () => dogPhoto
    );
    const tool = await resolveTool(
      dynamicContext([
        photoMessage(
          "наш пёс",
          new URL(
            "eve-sandbox:?path=%2Fworkspace%2Fattachments%2Fab%2Fdog.jpg&size=32&type=image%2Fjpeg"
          )
        ),
      ])
    );
    expect(tool.description).toContain("1 — sent with «наш пёс»");

    await execute(
      tool,
      { photos: [1], prompt: "The dog on a birthday card" },
      toolContext({ readBinaryFile })
    );

    expect(readBinaryFile).toHaveBeenCalledExactlyOnceWith({
      path: "/workspace/attachments/ab/dog.jpg",
    });
    const body = requestBodySchema.parse(
      JSON.parse(fetchMock.mock.calls[0]?.[1].body ?? "{}")
    );
    expect(body.input_references).toHaveLength(1);
  });

  it("edits an earlier picture of this conversation", async () => {
    mocks.readArtifact.mockResolvedValue({
      byteSize: earlierPicture.byteLength,
      contentHash: sha256(earlierPicture),
      filename: "picture.png",
      id: earlierId,
      mediaType: "image/png",
      storagePathname: "generated-images/user-1/earlier",
    });
    mocks.get.mockResolvedValue(blobResult(earlierPicture, "image/png"));
    const tool = await resolveTool(dynamicContext([]));

    await execute(tool, {
      images: [`![картинка](/artifacts/${earlierId})`],
      prompt: "The same birthday card, brighter and sunnier",
    });

    expect(mocks.readArtifact).toHaveBeenCalledExactlyOnceWith(
      scope,
      earlierId,
      { rootSessionId: "session-1" }
    );
    const body = requestBodySchema.parse(
      JSON.parse(fetchMock.mock.calls[0]?.[1].body ?? "{}")
    );
    expect(body.input_references?.[0]?.image_url.url).toBe(
      `data:image/png;base64,${Buffer.from(earlierPicture).toString("base64")}`
    );
  });

  it("hands back the picture a replayed call already drew", async () => {
    mocks.find.mockResolvedValue({
      byteSize: drawnPicture.byteLength,
      contentHash: sha256(drawnPicture),
      createdAt: new Date(),
      createdByUserId: scope.userId,
      filename: "picture.png",
      id: drawnId,
      idempotencyKey: "session-1:turn-1:call-1",
      mediaType: "image/png",
      model: "test/image-model",
      prompt: "A cake",
      rootSessionId: "session-1",
      storagePathname: "generated-images/user-1/drawn",
      workspaceId: scope.workspaceId,
    });
    const tool = await resolveTool(dynamicContext([]));

    const result = await execute(tool, { prompt: "A cake" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(result).toMatchObject({ artifact: `/artifacts/${drawnId}` });
  });

  it("draws nothing once the month's pictures run out", async () => {
    mocks.quota.mockResolvedValue({
      allowed: false,
      note: "Лимит картинок на этот месяц исчерпан.",
    });
    const tool = await resolveTool(dynamicContext([]));

    const result = await execute(tool, { prompt: "A cake" });

    expect(mocks.quota).toHaveBeenCalledExactlyOnceWith(scope);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(result).toEqual({
      note: "Лимит картинок на этот месяц исчерпан.",
      status: "quota_exhausted",
    });
  });

  it("fails with a reason the model can act on", async () => {
    const tool = await resolveTool(dynamicContext([]));

    await expect(
      execute(tool, { photos: [1], prompt: "The dog" })
    ).rejects.toThrow(
      "There is no photo 1; The person has sent no photos in this conversation."
    );
    await expect(
      execute(tool, { images: ["/artifacts/not-an-id"], prompt: "Brighter" })
    ).rejects.toThrow("is not a picture from this conversation");

    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: { message: "Request blocked by content policy" } },
        { status: 400 }
      )
    );
    await expect(execute(tool, { prompt: "Something" })).rejects.toThrow(
      "The image model refused the request (400): Request blocked by content policy"
    );

    fetchMock.mockResolvedValueOnce(Response.json({ data: [] }));
    await expect(execute(tool, { prompt: "Something" })).rejects.toThrow(
      "returned no picture"
    );
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

async function resolve(context: DynamicResolveContext) {
  const definition = (await import("@agent/tools/generate_image")).default;
  const handler = definition.events["turn.started"];
  if (!handler) throw new Error("generate_image resolves on turn.started.");
  return handler({}, context);
}

async function resolveTool(context: DynamicResolveContext) {
  const tool = await resolve(context);
  if (!tool || !("execute" in tool)) {
    throw new Error("generate_image resolves to a single tool.");
  }
  return tool;
}

type ResolvedTool = Awaited<ReturnType<typeof resolveTool>>;
type SandboxSession = Awaited<ReturnType<ToolContext["getSandbox"]>>;

async function execute(
  tool: ResolvedTool,
  input: Parameters<ResolvedTool["execute"]>[0],
  context = toolContext()
) {
  const result = await tool.execute(input, context);
  if (Symbol.asyncIterator in result) {
    throw new Error("generate_image returns one result, not a stream.");
  }
  return result;
}

function photoMessage(caption: string, data: string | URL) {
  return {
    content: [
      { text: caption, type: "text" as const },
      { data, mediaType: "image/jpeg", type: "file" as const },
    ],
    role: "user" as const,
  };
}

function dynamicContext(
  messages: DynamicResolveContext["messages"],
  authenticator = "photon-imessage"
) {
  return {
    channel: { kind: "channel:photon", metadata: {} },
    messages,
    model: null,
    session: {
      auth: {
        current: {
          attributes: { workspaceId: scope.workspaceId },
          authenticator,
          principalId: scope.userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}

function toolContext(sandbox?: Pick<SandboxSession, "readBinaryFile">) {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    async getSandbox() {
      if (!sandbox) {
        throw new Error("Sandbox access is outside this focused test.");
      }
      // SAFETY: The tool reads only binary files from the sandbox.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete sandbox session would add unrelated process and file handles.
      return sandbox as SandboxSession;
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
    toolName: "generate_image",
  } satisfies ToolContext;
}

function image(signature: readonly number[], length: number) {
  const bytes = new Uint8Array(length);
  bytes.set(signature);
  bytes.fill(7, signature.length);
  return bytes;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function blobResult(bytes: Uint8Array<ArrayBuffer>, contentType: string) {
  // SAFETY: The tool reads only the status, size, type and stream of a private blob.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete Blob result would add unrelated metadata.
  return {
    blob: { contentType, size: bytes.byteLength },
    statusCode: 200,
    stream: new Response(bytes).body,
  } as Awaited<ReturnType<typeof Blob.get>>;
}
