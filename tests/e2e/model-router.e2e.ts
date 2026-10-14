/**
 * The model router, pictures and clips against the real RouterAI: Bro's own
 * code makes every call — the decision model reads real jobs, Claude Haiku
 * answers through `directModelSelection` and caches its prompt, and
 * `generate_image` and `generate_video` draw a card and make clips, one of
 * them from that card as its first frame. Only the database rows and the
 * private bucket are kept in memory, so nothing reaches production's. Not
 * part of `pnpm check`: a run costs about 25 ₽ of RouterAI balance.
 *
 *   ROUTERAI_API_KEY=… E2E_OUT=<folder for the card and clips> \
 *   pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/model-router.e2e.ts
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateText } from "ai";
import type { DynamicResolveContext } from "eve";
import type { ToolContext } from "eve/tools";
import type { AccessScope } from "@shared/identity/access-scope";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const session = z
  .object({
    E2E_OUT: z.string().min(1).optional(),
    ROUTERAI_API_KEY: z
      .string()
      .transform((key) => key.replaceAll(/[“”‘’"\s]/gu, ""))
      .pipe(z.string().min(1)),
  })
  // oxlint-disable-next-line eslint/no-restricted-properties -- The run reads the session's key once, before any module validates its own settings.
  .parse(process.env);
const out = session.E2E_OUT;
const scope = { userId: "e2e-user", workspaceId: "personal:e2e" };

/** The private bucket, in memory: what was put comes back the same way. */
const bucket = new Map<
  string,
  { readonly bytes: Uint8Array; readonly mediaType: string }
>();
/** The rows of `generated_image_artifacts`, in memory. */
const rows = new Map<
  string,
  {
    readonly byteSize: number;
    readonly contentHash: string;
    readonly filename: string;
    readonly id: string;
    readonly idempotencyKey: string;
    readonly mediaType: string;
    readonly storagePathname: string;
  }
>();

vi.mock("@shared/object-storage/artifacts", () => ({
  artifactStorageConfigured: () => true,
  openArtifactObject: async (pathname: string) => {
    const object = bucket.get(pathname);
    if (object === undefined) return undefined;
    return await Promise.resolve({
      contentType: object.mediaType,
      etag: '"e2e"',
      size: object.bytes.byteLength,
      status: 200 as const,
      stream: new Response(object.bytes).body ?? new ReadableStream(),
    });
  },
  putArtifactObject: async (object: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly pathname: string;
  }) => {
    bucket.set(object.pathname, object);
    await Promise.resolve();
  },
}));
vi.mock("@agent/lib/billing/quota", () => ({
  imageGenerationQuotaGate: async () =>
    await Promise.resolve({ allowed: true, note: undefined }),
}));
vi.mock("@db/services/generated-images", () => ({
  findGeneratedImageArtifact: async (_scope: AccessScope, key: string) =>
    await Promise.resolve(
      [...rows.values()].find((row) => row.idempotencyKey === key)
    ),
  saveGeneratedImageArtifact: async (
    _scope: AccessScope,
    artifact: Omit<Parameters<typeof rows.set>[1], "id">
  ) => {
    const row = { ...artifact, id: crypto.randomUUID() };
    rows.set(row.id, row);
    return await Promise.resolve(row);
  },
}));
vi.mock("@db/services/artifacts", () => ({
  readReadyArtifact: async (_scope: AccessScope, id: string) =>
    await Promise.resolve(rows.get(id)),
}));

beforeAll(() => {
  for (const [name, value] of Object.entries({
    BETTER_AUTH_SECRET: "e2e-auth-secret-0123456789abcdefghijklmnop",
    BETTER_AUTH_URL: "https://bro.example",
    DATABASE_URL: "postgresql://user:password@127.0.0.1:1/database",
    MODEL_PROVIDER: "routerai",
    MODEL_ROUTER_WORKSPACES: "*",
    OPENROUTER_API_KEY: "",
    ROUTERAI_API_KEY: session.ROUTERAI_API_KEY,
    RUNINFRA_API_KEY: "",
    SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    VIDEO_WORKSPACES: "*",
  })) {
    vi.stubEnv(name, value);
  }
});

async function keep(name: string, bytes: Uint8Array) {
  if (out === undefined) return;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, name), bytes);
}

/** A stored artifact's bytes, by its `/artifacts/<id>`. */
function artifactBytes(artifact: string) {
  const row = rows.get(artifact.replace("/artifacts/", ""));
  const object = row && bucket.get(row.storagePathname);
  if (!row || !object) throw new Error(`${artifact} was not stored.`);
  expect(createHash("sha256").update(object.bytes).digest("hex")).toBe(
    row.contentHash
  );
  return { bytes: object.bytes, mediaType: row.mediaType };
}

describe("the model router", () => {
  const fallback = "deepseek/deepseek-v4.1-flash";
  const jobs = [
    [
      "anthropic/claude-haiku-5.5",
      "Goal: a 10-slide presentation in Russian about the coffee market in Russia in 2026, for investors. Format .pptx, clean modern design, charts where useful. Share the file with share_file.",
    ],
    [
      "anthropic/claude-haiku-5.5",
      "The person attached /workspace/attachments/sales.csv. Compute monthly revenue by region, find the top 3 products and plot revenue over time. Return the PNG and a short summary.",
    ],
    [
      fallback,
      "Research the 15 most popular CRM systems available in Russia in 2026: prices, free tiers, integrations with Telegram and 1C. Compare them in a short table in the report.",
    ],
  ] as const;

  it.each(jobs)("routes a job to %s", async (model, job) => {
    const { taskAgentModel } = await import("@agent/lib/model/router/task");
    const started = Date.now();
    await expect(
      taskAgentModel(
        scope,
        `e2e-${String(started)}-${job.slice(0, 8)}`,
        [
          {
            content: `You are a subagent.\nCaller message:\n${job}`,
            role: "user",
          },
        ],
        fallback
      )
    ).resolves.toBe(model);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("Claude Haiku through Bro's model selection", () => {
  it("answers and reads a repeated prompt from the cache", async () => {
    const { directModelSelection } = await import("@agent/lib/model/direct");
    // Anthropic caches a prefix past 4096 tokens on Haiku; the run's own
    // stamp makes the first call a write, never an old entry.
    const system = `${String(Date.now())}\n${Array.from(
      { length: 400 },
      (_, index) =>
        `Правило ${String(index)}: на слайде крупный заголовок, не больше пяти пунктов, контрастные цвета.`
    ).join("\n")}`;
    const ask = async () => {
      const selection = directModelSelection("anthropic/claude-haiku-5.5", {
        toolChoice: "auto",
      });
      return await generateText({
        messages: [{ content: "Ответь одним словом: готов?", role: "user" }],
        model: selection.model,
        providerOptions: selection.modelOptions.providerOptions,
        instructions: system,
      });
    };

    const first = await ask();
    const second = await ask();

    expect(first.text.trim().length).toBeGreaterThan(0);
    expect(second.usage.inputTokenDetails.cacheReadTokens ?? 0).toBeGreaterThan(
      10_000
    );
  });
});

describe("pictures and clips", () => {
  let card: string | undefined;

  it("draws a card with Russian lettering", async () => {
    const tool = await resolveTool(
      "generate_image",
      "нарисуй открытку на день рождения Маше с рыжим котом"
    );

    const artifact = await tool.execute(
      {
        aspectRatio: "1:1",
        prompt:
          'Поздравительная открытка: рыжий кот в праздничном колпаке среди шариков, тёплые цвета, сверху крупная надпись "С днём рождения, Маша!"',
      },
      toolContext("generate_image", "call-image")
    );

    const { bytes, mediaType } = artifactBytes(artifact);
    expect(mediaType).toMatch(/^image\/(?:png|jpeg|webp)$/u);
    expect(bytes.byteLength).toBeGreaterThan(50_000);
    await keep(`card.${mediaType.split("/")[1] ?? "img"}`, bytes);
    card = artifact;
  });

  it("makes a five-second clip from words", async () => {
    const tool = await resolveTool(
      "generate_video",
      "сделай видео: рыжий кот в очках идёт по пляжу"
    );

    const clip = await tool.execute(
      {
        aspectRatio: "16:9",
        prompt:
          "Рыжий кот в чёрных солнечных очках неспешно идёт по песчаному пляжу на закате, камера едет рядом",
      },
      toolContext("generate_video", "call-video")
    );

    const { bytes, mediaType } = artifactBytes(clip);
    expect(mediaType).toBe("video/mp4");
    expect(Buffer.from(bytes.subarray(4, 8)).toString("latin1")).toBe("ftyp");
    expect(bytes.byteLength).toBeGreaterThan(200_000);
    await keep("clip.mp4", bytes);
  });

  it("brings the card to life as a clip's first frame", async () => {
    if (card === undefined) throw new Error("The card was not drawn.");
    const tool = await resolveTool("generate_video", "оживи эту открытку");

    const clip = await tool.execute(
      {
        aspectRatio: "1:1",
        image: card,
        prompt: "Кот улыбается и машет лапой, шарики покачиваются",
      },
      toolContext("generate_video", "call-card-video")
    );

    const { bytes } = artifactBytes(clip);
    expect(Buffer.from(bytes.subarray(4, 8)).toString("latin1")).toBe("ftyp");
    await keep("card-clip.mp4", bytes);
  });
});

const readySchema = z.object({
  artifact: z.string(),
  status: z.literal("ready"),
});

async function resolveTool(
  name: "generate_image" | "generate_video",
  request: string
) {
  const definition = (
    name === "generate_image"
      ? await import("@agent/tools/generate_image")
      : await import("@agent/tools/generate_video")
  ).default;
  const tool = await definition.events["turn.started"]?.(
    {},
    dynamicContext(request)
  );
  if (!tool || !("execute" in tool)) {
    throw new Error(`${name} was not offered for «${request}».`);
  }
  return {
    async execute(
      input: Parameters<typeof tool.execute>[0],
      context: ToolContext
    ) {
      return readySchema.parse(await tool.execute(input, context)).artifact;
    },
  };
}

const caller = {
  attributes: { workspaceId: scope.workspaceId },
  authenticator: "photon-imessage",
  principalId: scope.userId,
  principalType: "user" as const,
};

function dynamicContext(request: string) {
  return {
    channel: { kind: "channel:photon", metadata: {} },
    messages: [
      Object.assign(
        { content: request, role: "user" as const },
        { kind: "user" }
      ),
    ],
    model: null,
    session: { auth: { current: caller, initiator: null }, id: "e2e-session" },
  } satisfies DynamicResolveContext;
}

function toolContext(toolName: string, callId: string) {
  return {
    abortSignal: new AbortController().signal,
    callId,
    async getSandbox() {
      throw new Error("No sandbox in this run.");
    },
    getSkill() {
      throw new Error("No skills in this run.");
    },
    async getToken() {
      throw new Error("No tokens in this run.");
    },
    requireAuth() {
      throw new Error("No authorization in this run.");
    },
    session: {
      auth: { current: caller, initiator: null },
      id: "e2e-session",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName,
  } satisfies ToolContext;
}
