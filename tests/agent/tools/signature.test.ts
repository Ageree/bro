import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as samples from "@db/services/signatures/samples";
import type * as files from "@agent/lib/sandbox/files";
import type { runFreshKit } from "@agent/lib/sandbox/kit";
import {
  ContextContainer,
  contextStorage,
} from "../../../node_modules/eve/dist/src/context/container.js";

const services = vi.hoisted(() => ({
  kit: vi.fn<typeof runFreshKit>(),
  save: vi.fn<typeof samples.saveSignatureSample>(),
  share: vi.fn<typeof files.shareSandboxFile>(),
  summary: vi.fn<typeof samples.readSignatureSummary>(),
}));

vi.mock("@db/services/signatures/samples", () => ({
  deleteSignatureSample: async () => true,
  readSignatureSummary: services.summary,
  saveSignatureSample: services.save,
}));
vi.mock("@agent/lib/sandbox/kit", () => ({ runFreshKit: services.kit }));
vi.mock("@agent/lib/sandbox/files", async (original) => ({
  ...(await original<typeof files>()),
  shareSandboxFile: services.share,
}));
vi.mock("@agent/lib/signatures/pilot", () => ({
  signEnabled: () => true,
  signOfCaller: () => true,
}));

import { recordPhoneTurn } from "@agent/lib/phone/policy";
import signatureTools from "@agent/tools/signature";

const scope = { userId: "alice", workspaceId: "workspace:alice" };
const folder = "/workspace/attachments/0123456789abcdef";

/** A PNG header the size checks read; the kit is what draws it. */
function png() {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(880, 16);
  bytes.writeUInt32BE(240, 20);
  return new Uint8Array(bytes);
}

function person(text: string, photos: string[] = []): ModelMessage {
  return Object.assign(
    {
      content: [
        { text, type: "text" as const },
        ...photos.map((name) => {
          const url = new URL("eve-sandbox:");
          url.searchParams.set("path", `${folder}/${name}`);
          url.searchParams.set("size", "1000");
          url.searchParams.set("type", "image/jpeg");
          return { data: url, mediaType: "image/jpeg", type: "file" as const };
        }),
      ],
      role: "user" as const,
    },
    { kind: "user" }
  );
}

function unused(): never {
  throw new Error("Not used by these cases.");
}

const written = new Map<string, Uint8Array>();
const sandbox = {
  delete: unused,
  id: "sandbox-1",
  readBinaryFile: async ({ path }: { path: string }) =>
    written.get(path) ?? null,
  readFile: unused,
  readTextFile: unused,
  removePath: async () => undefined,
  resolvePath: (path: string) => path,
  run: unused,
  setNetworkPolicy: unused,
  spawn: unused,
  stop: unused,
  writeBinaryFile: unused,
  writeFile: unused,
  writeTextFile: unused,
};

function caller(authenticator: string) {
  return {
    attributes: { conversationChannel: "eve", workspaceId: scope.workspaceId },
    authenticator,
    principalId: scope.userId,
    principalType: "user" as const,
  };
}

function context(authenticator = "authjs") {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: async () => sandbox,
    getSkill: unused,
    getToken: unused,
    requireAuth: unused,
    session: {
      auth: { current: caller(authenticator), initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "signature",
  } satisfies ToolContext;
}

async function resolve(messages: ModelMessage[], authenticator = "authjs") {
  const resolved: DynamicResolveContext = {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: {
      auth: { current: caller(authenticator), initiator: null },
      id: "session-1",
    },
  };
  const tools = await signatureTools.events["step.started"]?.(
    { data: { stepIndex: 0, turnId: "turn-1" } },
    resolved
  );
  if (!tools || !("signature" in tools)) throw new Error("Expected the tool.");
  return tools.signature;
}

type Input = Parameters<Awaited<ReturnType<typeof resolve>>["execute"]>[0];

/** The approval and then execute, as eve runs one call of a turn. */
async function call(
  messages: ModelMessage[],
  input: Input,
  opened: "background-message" | "person-message" = "person-message"
) {
  return await contextStorage.run(new ContextContainer(), async () => {
    const tool = await resolve(messages);
    const ctx = context();
    recordPhoneTurn(ctx.session, "start");
    recordPhoneTurn(ctx.session, opened);
    if (tool.approval === undefined) throw new Error("Expected a policy.");
    const policy =
      "request" in tool.approval ? tool.approval.request : tool.approval;
    await policy({ ...ctx, approvedTools: new Set(), toolInput: input });
    return await tool.execute(input, ctx);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  written.clear();
  services.summary.mockResolvedValue(null);
  services.save.mockResolvedValue({ id: "sample-1", replaced: false });
  services.share.mockResolvedValue({
    bytes: 33,
    mediaType: "image/png",
    name: "Подпись (образец).png",
    url: "https://example.com/preview.png",
  });
  services.kit.mockImplementation(async (_box, _dir, args) => {
    written.set(args[4] ?? "", png());
    written.set(args[6] ?? "", png());
    return { exitCode: 0, json: { ok: true }, stderr: "" };
  });
});

describe("the signature sample", () => {
  it("tells whether one is saved in any turn, without the person's message", async () => {
    const tool = await resolve([person("Что у меня сохранено?")]);
    expect(await tool.execute({ action: "status" }, context())).toEqual({
      status: "none",
    });
    services.summary.mockResolvedValue({
      id: "sample-1",
      kind: "image",
      savedAt: new Date("2026-10-15T10:00:00Z"),
    });
    expect(await tool.execute({ action: "status" }, context())).toEqual({
      kind: "image",
      savedAt: "2026-10-15T10:00:00.000Z",
      status: "saved",
    });
  });

  it("never saves someone else's signature, as a photo or as a typed name", async () => {
    expect(
      await call([person("Вот её подпись со старой расписки", ["IMG_1.jpg"])], {
        action: "save",
        path: `${folder}/IMG_1.jpg`,
      })
    ).toMatchObject({ status: "not_own" });
    expect(
      await call(
        [
          person(
            "Сохрани подпись мужа: Петров Пётр Иванович, буду подписывать за него"
          ),
        ],
        { action: "save_typed", name: "Петров Пётр Иванович" }
      )
    ).toMatchObject({ status: "not_own" });
    expect(services.save).not.toHaveBeenCalled();
  });

  it("takes the only photo of the turn for a mistyped path, but never guesses among several", async () => {
    const wrong = { action: "save" as const, path: `${folder}/IMG_9.jpg` };
    expect(
      await call([person("Вот моя подпись", ["IMG_1.jpg", "IMG_2.jpg"])], wrong)
    ).toMatchObject({ status: "not_this_turn" });
    expect(
      await call([person("Вот моя подпись", ["IMG_1.jpg"])], wrong)
    ).toMatchObject({
      previewUrl: "https://example.com/preview.png",
      status: "saved",
    });
    expect(services.kit.mock.lastCall?.[2]).toContain(`${folder}/IMG_1.jpg`);
  });

  it("saves a typed name only as the person wrote it", async () => {
    expect(
      await call([person("Сделай подпись шрифтом")], {
        action: "save_typed",
        name: "Смирнова А.В.",
      })
    ).toMatchObject({ status: "name_not_quoted" });
    expect(services.save).not.toHaveBeenCalled();
  });

  it("offers a typed name when the kit cannot run", async () => {
    services.kit.mockRejectedValue(new Error("sandbox down"));
    expect(
      await call([person("Вот моя подпись", ["IMG_1.jpg"])], {
        action: "save",
        path: `${folder}/IMG_1.jpg`,
      })
    ).toMatchObject({ status: "unavailable" });
  });

  it("saves nothing in a turn the person's message did not open", async () => {
    expect(
      await call(
        [person("Вот моя подпись", ["IMG_1.jpg"])],
        { action: "save", path: `${folder}/IMG_1.jpg` },
        "background-message"
      )
    ).toMatchObject({ status: "not_allowed" });
    expect(services.save).not.toHaveBeenCalled();
  });
});
