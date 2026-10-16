import { createHash } from "node:crypto";
import type * as ai from "ai";
import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DocumentSigning } from "@db/schema/signatures";
import type * as samples from "@db/services/signatures/samples";
import type * as signings from "@db/services/signatures/signings";
import type * as files from "@agent/lib/sandbox/files";
import type { runFreshKit } from "@agent/lib/sandbox/kit";
import {
  ContextContainer,
  contextStorage,
} from "../../../node_modules/eve/dist/src/context/container.js";

const services = vi.hoisted(() => ({
  cancel: vi.fn<typeof signings.cancelSigning>(),
  claim: vi.fn<typeof signings.claimSigning>(),
  judge: vi.fn<() => Promise<{ output: { matches: boolean } }>>(),
  kit: vi.fn<typeof runFreshKit>(),
  list: vi.fn<typeof signings.listSignings>(),
  pilot: { on: true },
  prepare: vi.fn<typeof signings.prepareSigning>(),
  read: vi.fn<typeof signings.readSigning>(),
  readShared: vi.fn<typeof files.readOwnedSharedFile>(),
  release: vi.fn<typeof signings.releaseSigning>(),
  sample: vi.fn<typeof samples.readSignatureSample>(),
  save: vi.fn<typeof samples.saveSignatureSample>(),
  settle: vi.fn<typeof signings.settleSigning>(),
  share: vi.fn<typeof files.shareSandboxFile>(),
  summary: vi.fn<typeof samples.readSignatureSummary>(),
}));

vi.mock("@db/services/signatures/signings", () => ({
  cancelSigning: services.cancel,
  claimSigning: services.claim,
  listSignings: services.list,
  prepareSigning: services.prepare,
  readSigning: services.read,
  releaseSigning: services.release,
  settleSigning: services.settle,
}));
vi.mock("@db/services/signatures/samples", () => ({
  readSignatureSample: services.sample,
  readSignatureSummary: services.summary,
  saveSignatureSample: services.save,
}));
vi.mock("@db/services/settings", () => ({
  getFormOfAddress: async () => ({ formal: false, name: null }),
  getWorkspaceModelId: async () => "synthetic/model",
}));
vi.mock("@db/services/user-profile", () => ({
  readWorkspaceTimeZone: async () => "Europe/Moscow",
}));
vi.mock("ai", async (original) => ({
  ...(await original<typeof ai>()),
  generateText: services.judge,
}));
vi.mock("@agent/lib/sandbox/kit", () => ({ runFreshKit: services.kit }));
vi.mock("@agent/lib/sandbox/files", async (original) => ({
  ...(await original<typeof files>()),
  readOwnedSharedFile: services.readShared,
  shareSandboxFile: services.share,
}));
vi.mock("@agent/lib/signatures/pilot", () => ({
  signEnabled: () => services.pilot.on,
  signOfCaller: () => services.pilot.on,
}));

// Share links are signed with the sandbox key, read when modules load.
vi.stubEnv("SANDBOX_SIGNING_KEY", "33".repeat(32));
const { recordPhoneTurn } = await import("@agent/lib/phone/policy");
const { sandboxFileLinkSignature } = await import("@agent/lib/sandbox/keys");
const { default: signTools } = await import("@agent/tools/sign_document");

const scope = { userId: "alice", workspaceId: "workspace:alice" };
const signingId = "6f6f5d78-641b-4c80-aacf-eec05af14e53";
const otherId = "7f6f5d78-641b-4c80-aacf-eec05af14e53";
const sampleId = "0d6f5d78-641b-4c80-aacf-eec05af14e53";
const shareId = "a1".repeat(12);
const link = `https://example.com/eve/v1/sandbox-files/${shareId}/anketa.pdf?sig=${sandboxFileLinkSignature(`sandbox/files/${shareId}/anketa.pdf`)}`;
const signedUrl = "https://example.com/eve/v1/sandbox-files/b2/signed.pdf";
const photoPath = "/workspace/attachments/0123456789abcdef/podpis.jpg";

const pdf = new TextEncoder().encode("%PDF-1.7\nsynthetic form\n%%EOF");
const signedPdf = new TextEncoder().encode("%PDF-1.7\nsigned form\n%%EOF");
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** A PNG header the size checks read; the kit is what draws it. */
function png(width: number, height: number) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return new Uint8Array(bytes);
}
const signaturePng = png(880, 240);

const today = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Moscow",
  year: "numeric",
}).format(new Date());

const question = `Ставлю твою сохранённую подпись на «anketa.pdf»: подпись — стр. 1 («Подпись заявителя»); дата ${today} — стр. 1. Это картинка подписи и дата, а не электронная подпись (КЭП). Подписываю?`;

const plan = {
  pages: 1,
  places: [
    {
      field: "bro_sign_signature_1",
      label: "Подпись заявителя",
      mark: true,
      pages: [1],
      role: "signature" as const,
    },
    {
      field: "bro_sign_date_1",
      label: "Дата",
      mark: true,
      pages: [1],
      role: "date" as const,
    },
  ],
};

const inventory = {
  ok: true,
  pages: 1,
  places: plan.places.map((place, index) => ({
    bro: { n: 1, role: place.role },
    empty: true,
    field: place.field,
    hidden: false,
    hint: place.role,
    label: place.label,
    marked: true,
    page: 1,
    type: index === 0 ? "signature" : "text",
  })),
  signed_by_bro: false,
  signed_fields: [],
  status: "ok",
};

function row(overrides: Partial<DocumentSigning> = {}): DocumentSigning {
  // One message of Bro's carried the file and the question.
  const delivered = Date.now() - 60_000;
  return {
    ...scope,
    askedAt: new Date(delivered),
    askedText: question,
    askedTurn: "session-1\nturn-0",
    askedVerbatim: true,
    confirmCallId: null,
    consentText: null,
    createdAt: new Date(Date.now() - 120_000),
    dateText: today,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    fingerprint: "fingerprint",
    id: signingId,
    language: "ru",
    outputBytes: null,
    outputSha256: null,
    outputUrl: null,
    plan,
    prepareCallId: "call-0",
    question,
    rootSessionId: "session-1",
    shownAt: new Date(delivered),
    signatureId: sampleId,
    signatureKind: "image",
    signaturePhotoPath: null,
    signaturePngSha256: null,
    signatureSource: "saved",
    signedAt: null,
    sourceBytes: pdf.byteLength,
    sourceKind: "shared",
    sourceName: "anketa.pdf",
    sourceRef: link,
    sourceSha256: sha256(pdf),
    sourceShareId: shareId,
    status: "prepared",
    updatedAt: new Date(),
    ...overrides,
  };
}

function person(text: string, photos: string[] = []): ModelMessage {
  return Object.assign(
    {
      content: [
        { text, type: "text" as const },
        ...photos.map((path) => {
          const url = new URL("eve-sandbox:");
          url.searchParams.set("path", path);
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

/** The task agent's report of the filled file, as eve delivers it. */
function reportOf(result: string, taskId = "task_1"): ModelMessage {
  return Object.assign(
    {
      content: `Background task ${taskId} (task) is completed.\n\nResult:\n${result}`,
      role: "user" as const,
    },
    { kind: "execution.background_task" }
  );
}

const taskReport = reportOf(
  `Анкета заполнена, места подписи отмечены: ${link}`
);

/**
 * Bro's `task` call, a start or (with `continues`) a continuation, and eve's
 * receipt of it: `{ status: "working", taskId, agentId }`.
 */
function gave(
  taskId = "task_1",
  { agentId = `ag_${taskId}`, continues = false } = {}
): ModelMessage[] {
  const toolCallId = `call-${taskId}`;
  return [
    {
      content: [
        {
          input: continues
            ? { agentId, message: "Исправь и пришли снова" }
            : { message: "Заполни анкету" },
          toolCallId,
          toolName: "task",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: {
            type: "json",
            value: { agentId, status: "working", taskId },
          },
          toolCallId,
          toolName: "task",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
}

/** The person's words, the task Bro gave on them and its report. */
const reported = (words: string, photos: string[] = []) => [
  person(words, photos),
  ...gave(),
  taskReport,
];

const asked: ModelMessage[] = [
  person("Заполни анкету и подпиши"),
  taskReport,
  {
    content: [
      {
        input: {
          attachments: [{ kind: "file", url: link }],
          kind: "message",
          text: question,
        },
        toolCallId: "send-1",
        toolName: "send_message",
        type: "tool-call",
      },
    ],
    role: "assistant",
  },
  {
    content: [
      {
        output: { type: "json", value: { status: "sent" } },
        toolCallId: "send-1",
        toolName: "send_message",
        type: "tool-result",
      },
    ],
    role: "tool",
  },
];

function unused(): never {
  throw new Error("The kit runs are mocked at runFreshKit.");
}

/** Bro's sandbox as the tool reaches it: files in memory. */
function fakeSandbox() {
  const stored = new Map<string, Uint8Array>();
  return {
    delete: unused,
    id: "sandbox-1",
    readBinaryFile: async ({ path }: { path: string }) =>
      stored.get(path) ?? null,
    readFile: async ({ path }: { path: string }) => {
      const bytes = stored.get(path);
      return bytes === undefined
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          });
    },
    readTextFile: async ({ path }: { path: string }) => {
      const bytes = stored.get(path);
      return bytes === undefined ? null : Buffer.from(bytes).toString("utf8");
    },
    removePath: async () => undefined,
    resolvePath: (path: string) => path,
    run: unused,
    setNetworkPolicy: unused,
    spawn: unused,
    stop: unused,
    stored,
    writeBinaryFile: async (options: { content: Uint8Array; path: string }) => {
      stored.set(options.path, options.content);
    },
    writeFile: unused,
    writeTextFile: async (options: { content: string; path: string }) => {
      stored.set(options.path, Buffer.from(options.content));
    },
  };
}

let sandbox = fakeSandbox();

function caller(authenticator: string) {
  return {
    attributes: { conversationChannel: "eve", workspaceId: scope.workspaceId },
    authenticator,
    principalId: scope.userId,
    principalType: "user" as const,
  };
}

function resolveContext(
  messages: ModelMessage[],
  authenticator = "authjs"
): DynamicResolveContext {
  return {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: {
      auth: { current: caller(authenticator), initiator: null },
      id: "session-1",
    },
  };
}

function callContext(callId: string, authenticator = "authjs") {
  return {
    abortSignal: new AbortController().signal,
    callId,
    getSandbox: async () => sandbox,
    getSkill: unused,
    getToken: unused,
    requireAuth: unused,
    session: {
      auth: { current: caller(authenticator), initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "sign_document",
  } satisfies ToolContext;
}

async function resolve(messages: ModelMessage[], authenticator = "authjs") {
  const tools = await signTools.events["step.started"]?.(
    { data: { stepIndex: 0, turnId: "turn-1" } },
    resolveContext(messages, authenticator)
  );
  return tools && "sign_document" in tools ? tools.sign_document : undefined;
}

/**
 * One call as eve makes it in a turn the person's message (or the task
 * agent's report) opened: the approval, then execute with the same call.
 */
async function call(
  messages: ModelMessage[],
  input: Parameters<
    NonNullable<Awaited<ReturnType<typeof resolve>>>["execute"]
  >[0],
  {
    callId = "call-1",
    opened = "person-message",
  }: {
    readonly callId?: string;
    readonly opened?: "background-message" | "person-message";
  } = {}
) {
  return await contextStorage.run(new ContextContainer(), async () => {
    const context = callContext(callId);
    recordPhoneTurn(context.session, "start");
    recordPhoneTurn(context.session, opened);
    const tool = await resolve(messages);
    if (tool?.approval === undefined) throw new Error("Expected the tool.");
    const policy =
      "request" in tool.approval ? tool.approval.request : tool.approval;
    const approval = await policy({
      ...context,
      approvedTools: new Set(),
      toolInput: input,
    });
    return { approval, result: await tool.execute(input, context) };
  });
}

const confirmInput = { action: "confirm" as const, signingId };
const yes = [...asked, person("да, подписывай")];

/** The PLAN.json the tool wrote for the kit. */
const planSchema = z.object({
  places: z.array(z.object({ field: z.string() })),
});

const stampRuns = () =>
  services.kit.mock.calls.filter(([, , args]) => args[1] === "stamp-sign");

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  sandbox = fakeSandbox();
  services.pilot.on = true;
  services.judge.mockResolvedValue({ output: { matches: false } });
  services.read.mockResolvedValue(row());
  services.prepare.mockImplementation(async (_scope, input) =>
    row({
      ...input,
      askedAt: null,
      askedText: null,
      askedTurn: null,
      askedVerbatim: false,
      id: signingId,
    })
  );
  services.summary.mockResolvedValue({
    id: sampleId,
    kind: "image",
    savedAt: new Date(Date.now() - 86_400_000),
  });
  services.sample.mockResolvedValue({
    id: sampleId,
    kind: "image",
    png: signaturePng,
  });
  services.save.mockResolvedValue({ id: sampleId, replaced: false });
  services.readShared.mockResolvedValue({
    bytes: pdf,
    mediaType: "application/pdf",
    name: "anketa.pdf",
  });
  services.claim.mockImplementation(async (_scope, input) => ({
    kind: "claimed",
    row: row({ confirmCallId: input.callId, status: "signing" }),
  }));
  services.settle.mockResolvedValue(true);
  services.release.mockResolvedValue(undefined);
  services.list.mockResolvedValue([]);
  services.share.mockImplementation(async (input) => ({
    bytes: input.bytes.byteLength,
    mediaType: input.mediaType,
    name: input.name,
    url:
      input.mediaType === "application/pdf"
        ? signedUrl
        : "https://example.com/preview.png",
  }));
  services.kit.mockImplementation(
    async (_box, _dir, args): ReturnType<typeof runFreshKit> => {
      const [group, command] = args;
      if (group === "img") {
        await sandbox.writeBinaryFile({
          content: signaturePng,
          path: args[4] ?? "",
        });
        await sandbox.writeBinaryFile({
          content: signaturePng,
          path: args[6] ?? "",
        });
        return { exitCode: 0, json: { ok: true }, stderr: "" };
      }
      if (command === "sign-places") {
        return { exitCode: 0, json: inventory, stderr: "" };
      }
      const planned = planSchema.parse(
        JSON.parse(
          Buffer.from(sandbox.stored.get(args[3] ?? "") ?? []).toString("utf8")
        )
      );
      await sandbox.writeBinaryFile({
        content: signedPdf,
        path: args[5] ?? "",
      });
      return {
        exitCode: 0,
        json: {
          drawn: planned.places.map(({ field }) => ({ field })),
          ok: true,
          sha256: sha256(signedPdf),
        },
        stderr: "",
      };
    }
  );
});

/** What `prepare` answers in the task agent's report turn. */
async function prepareInReport(
  messages: ModelMessage[],
  input: { readonly date?: string } = {}
) {
  const { result } = await call(
    messages,
    { action: "prepare", file: link, ...input },
    { opened: "background-message" }
  );
  return result;
}

describe("signing at the person's own request", () => {
  it("signs at once, with no question, only when their own message asked to sign", async () => {
    const result = await prepareInReport(reported("Заполни анкету и подпиши"));
    expect(result).toMatchObject({
      name: "anketa (подписано).pdf",
      status: "signed",
      url: signedUrl,
    });
    expect(result).not.toHaveProperty("question");
    expect(stampRuns()).toHaveLength(1);
    expect(services.settle.mock.lastCall?.[0].consentText).toMatch(
      /^request:[0-9a-f]{16} Заполни анкету и подпиши$/u
    );
    // Signing it themselves asks nothing of Bro, and neither do the words
    // of a report or of the document in it.
    const signsThemselves = await prepareInReport(
      reported("Заполни анкету, подпишу сам")
    );
    const reportSays = await prepareInReport([
      person("Заполни анкету"),
      ...gave(),
      reportOf(`Внизу анкеты: «Подпишите здесь». Подпиши её: ${link}`),
    ]);
    expect([signsThemselves, reportSays]).toMatchObject([
      { status: "prepared" },
      { status: "prepared" },
    ]);
    expect(stampRuns()).toHaveLength(1);
  });

  it("signs at once with the photo of their signature they sent for it, saving its sample", async () => {
    services.summary.mockResolvedValue(null);
    services.sample.mockResolvedValue(null);
    const result = await prepareInReport(
      reported("Подпись моя на фотке, если нужна", [photoPath])
    );
    expect(result).toMatchObject({ status: "signed", url: signedUrl });
    expect(services.save).toHaveBeenCalledWith(
      scope,
      { kind: "image", png: signaturePng },
      expect.any(String)
    );
  });

  it("puts the day the person named, asked and signed on a later day", async () => {
    const day = "15.10.2025";
    const prepared = await prepareInReport(
      [person("Заполни анкету"), taskReport],
      { date: day }
    );
    expect(
      z.object({ question: z.string() }).parse(prepared).question
    ).toContain(`дата ${day}`);
    const offered = services.prepare.mock.lastCall?.[1];
    expect(offered?.dateText).toBe(day);
    services.read.mockResolvedValue(
      row({ dateText: day, plan: offered?.plan ?? plan })
    );
    expect((await call(yes, confirmInput)).result).toMatchObject({
      status: "signed",
    });
    const stamped = [...sandbox.stored]
      .filter(([path]) => path.endsWith("/plan.json"))
      .map(([, bytes]) =>
        z
          .object({ date: z.string() })
          .parse(JSON.parse(Buffer.from(bytes).toString("utf8")))
      );
    expect(stamped).toEqual([{ date: day }]);
  });

  it("keeps as consent only the words that asked, without document numbers", async () => {
    await prepareInReport(
      reported(
        "Заполни анкету на паспорт 4510 123456 и подпиши. Отдел продаж, если что."
      )
    );
    const kept = services.settle.mock.lastCall?.[0].consentText ?? "";
    expect(kept).toMatch(/подпиши/u);
    expect(kept).not.toMatch(/123456|Отдел/u);
  });

  it("asks only when the person's words say so, never on the model's say", async () => {
    // Live 16.10: the form, the photo and these words, and the model held the
    // signing back with `ask: true` — nothing was signed.
    services.summary.mockResolvedValue(null);
    services.sample.mockResolvedValue(null);
    const words =
      "Заполни анкету. Дату ставь сегодняшнюю. Подпись моя на фотке, если нужна.";
    const schema = (await resolve(reported(words, [photoPath])))?.inputSchema;
    if (!(schema instanceof z.ZodType)) {
      throw new TypeError("Expected the tool's Zod input schema.");
    }
    expect(
      schema.safeParse({ action: "prepare", ask: true, file: link }).data
    ).toStrictEqual({ action: "prepare", file: link });
    expect(await prepareInReport(reported(words, [photoPath]))).toMatchObject({
      status: "signed",
      url: signedUrl,
    });
    expect(
      await prepareInReport(
        reported(`${words} Только сначала покажи.`, [photoPath])
      )
    ).toMatchObject({ status: "prepared" });
    expect(stampRuns()).toHaveLength(1);
  });

  it("never signs for someone else, and says so", async () => {
    const result = await prepareInReport(
      reported("Заполни анкету и подпиши за мужа")
    );
    expect(result).toMatchObject({ status: "someone_else" });
    expect(z.object({ reply: z.string() }).parse(result).reply).toMatch(
      /never put another person's signature/u
    );
    expect(services.prepare).not.toHaveBeenCalled();
    expect(stampRuns()).toHaveLength(0);
  });

  it("signs one document per request: another one, in a later report, asks", async () => {
    const messages = reported("Заполни анкету и подпиши");
    expect(await prepareInReport(messages)).toMatchObject({ status: "signed" });
    const consentText = services.settle.mock.lastCall?.[0].consentText ?? null;
    services.list.mockResolvedValue([
      row({ consentText, outputUrl: signedUrl, status: "signed" }),
    ]);
    services.prepare.mockImplementation(async (_scope, input) =>
      row({ ...input, askedAt: null, askedText: null, id: otherId })
    );
    expect(await prepareInReport(messages)).toMatchObject({
      status: "prepared",
    });
    expect(stampRuns()).toHaveLength(1);
  });

  it("signs one of two documents prepared in the same step at once", async () => {
    services.prepare.mockImplementation(async (_scope, input) =>
      row({
        ...input,
        askedAt: null,
        askedText: null,
        id: input.prepareCallId === "call-1" ? signingId : otherId,
      })
    );
    const messages = reported("Заполни анкету и подпиши");
    const statuses = await Promise.all(
      ["call-1", "call-2"].map(async (callId) => {
        const { result } = await call(
          messages,
          { action: "prepare", file: link },
          { callId, opened: "background-message" }
        );
        return z.object({ status: z.string() }).parse(result).status;
      })
    );
    expect(statuses.toSorted((a, b) => a.localeCompare(b))).toEqual([
      "prepared",
      "signed",
    ]);
    expect(stampRuns()).toHaveLength(1);
  });

  it("finishes its own signing when eve runs the step again, leaves another call's live one and takes over a dead one's", async () => {
    const claimedBy = (confirmCallId: string) =>
      services.prepare.mockImplementation(async (_scope, input) =>
        row({ ...input, confirmCallId, status: "signing" })
      );
    const messages = reported("Заполни анкету и подпиши");
    claimedBy("call-1");
    expect(await prepareInReport(messages)).toMatchObject({
      status: "signed",
      url: signedUrl,
    });
    // `claimSigning` takes this call's own claim or one older than ten
    // minutes, and is busy otherwise.
    claimedBy("call-0");
    services.claim.mockResolvedValueOnce({ kind: "busy" });
    const other = await prepareInReport(messages);
    expect(other).toMatchObject({ status: "busy" });
    expect(z.object({ reply: z.string() }).parse(other).reply).toMatch(
      /do not prepare it again/u
    );
    expect(stampRuns()).toHaveLength(1);
    expect(await prepareInReport(messages)).toMatchObject({
      status: "signed",
      url: signedUrl,
    });
    expect(stampRuns()).toHaveLength(2);
    // With no request to sign it with, the dead call's claim goes back to
    // an offer, and the question.
    expect(await prepareInReport(reported("Заполни анкету"))).toMatchObject({
      status: "prepared",
    });
    expect(services.release).toHaveBeenLastCalledWith({
      callId: "call-1",
      id: signingId,
    });
    expect(stampRuns()).toHaveLength(2);
  });

  it("asks when the report is of a task given before the person's newest request, and signs the task given on it", async () => {
    const beforeRequest = [
      person("Заполни заявление"),
      ...gave("task_a"),
      person("И анкету заполни и подпиши"),
      ...gave("task_b"),
    ];
    expect(
      await prepareInReport([
        ...beforeRequest,
        reportOf(`Заявление заполнено: ${link}`, "task_a"),
      ])
    ).toMatchObject({ status: "prepared" });
    expect(stampRuns()).toHaveLength(0);
    expect(
      await prepareInReport([
        ...beforeRequest,
        reportOf(`Анкета заполнена: ${link}`, "task_b"),
      ])
    ).toMatchObject({ status: "signed" });
    // A task given before the request and continued on it is given on it.
    expect(
      await prepareInReport([
        person("Заполни анкету"),
        ...gave("task_c"),
        reportOf(`Анкета заполнена: ${link}`, "task_c"),
        person("Исправь дату и подпиши"),
        ...gave("task_d", { agentId: "ag_task_c", continues: true }),
        reportOf(`Дата исправлена: ${link}`, "task_d"),
      ])
    ).toMatchObject({ status: "signed" });
    expect(stampRuns()).toHaveLength(2);
  });

  it("refuses a day that does not exist", async () => {
    expect(
      await prepareInReport([person("Заполни анкету"), taskReport], {
        date: "31.02.2026",
      })
    ).toMatchObject({ status: "bad_date" });
    expect(services.prepare).not.toHaveBeenCalled();
  });
});

describe("preparing a signing", () => {
  it("offers the code-built question in the task agent's report turn, where confirm is refused", async () => {
    const report = [person("Заполни анкету"), taskReport];
    const prepared = await call(
      report,
      { action: "prepare", file: link },
      { opened: "background-message" }
    );
    expect(prepared.result).toMatchObject({
      attachUrl: link,
      status: "prepared",
    });
    expect(
      z.object({ question: z.string() }).parse(prepared.result).question
    ).toMatch(/Подписываю\?$/u);
    const confirmed = await call(report, confirmInput, {
      opened: "background-message",
    });
    expect(confirmed.approval).toMatchObject({ type: "denied" });
    expect(confirmed.result).toMatchObject({ status: "not_allowed" });
    expect(stampRuns()).toHaveLength(0);
  });

  it("offers the photo the person called their signature, with its preview", async () => {
    services.summary.mockResolvedValue(null);
    const messages = [
      person("Это моя подпись", [photoPath]),
      person("Заполни анкету"),
      taskReport,
    ];
    const prepared = await call(
      messages,
      { action: "prepare", file: link },
      { opened: "background-message" }
    );
    expect(prepared.result).toMatchObject({
      previewUrl: "https://example.com/preview.png",
      status: "prepared",
    });
    expect(services.prepare.mock.lastCall?.[1]).toMatchObject({
      signaturePhotoPath: photoPath,
      signaturePngSha256: sha256(signaturePng),
      signatureSource: "photo",
    });
  });

  it("asks for a signature when no photo was called the person's own", async () => {
    services.summary.mockResolvedValue(null);
    const prepared = await call(
      [person("Вот документы", [photoPath]), taskReport],
      { action: "prepare", file: link },
      { opened: "background-message" }
    );
    expect(prepared.result).toMatchObject({ status: "no_signature" });
    expect(services.prepare).not.toHaveBeenCalled();
  });

  it("does not ask for another photo when the kit cannot run", async () => {
    services.summary.mockResolvedValue(null);
    services.kit.mockRejectedValue(new Error("The kit did not start"));
    const prepared = await call(
      [person("Подпись моя на фотке", [photoPath]), taskReport],
      { action: "prepare", file: link },
      { opened: "background-message" }
    );
    expect(prepared.result).toMatchObject({ status: "unavailable" });
    expect(services.prepare).not.toHaveBeenCalled();
  });
});

describe("confirming a signing", () => {
  it("signs after the person's plain yes to the question delivered in an earlier turn", async () => {
    const { approval, result } = await call(yes, confirmInput);
    expect(approval).toBe("not-applicable");
    expect(result).toMatchObject({
      name: "anketa (подписано).pdf",
      status: "signed",
      url: signedUrl,
    });
    expect(services.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: "call-1",
        consentText: "да, подписывай",
      })
    );
  });

  it("keeps the yes as consent the way the request's words are kept, cut between characters", async () => {
    const smiles = "🙂".repeat(240);
    expect(
      (await call([...asked, person(`да ${smiles}`)], confirmInput)).result
    ).toMatchObject({ status: "signed" });
    expect(services.settle.mock.lastCall?.[0].consentText).toBe(
      `да ${"🙂".repeat(197)}`
    );
  });

  it("never signs on a yes when nothing was asked", async () => {
    services.read.mockResolvedValue(
      row({ askedAt: null, askedText: null, askedTurn: null })
    );
    const { result } = await call(yes, confirmInput);
    expect(result).toMatchObject({ status: "confirmation_required" });
    expect(stampRuns()).toHaveLength(0);
  });

  it("needs the question asked before the person's message, not in this turn", async () => {
    services.read.mockResolvedValue(row({ askedTurn: "session-1\nturn-1" }));
    expect((await call(yes, confirmInput)).result).toMatchObject({
      status: "confirmation_required",
    });
  });

  it("takes a question in Bro's own words only when the judge finds it the same signing", async () => {
    services.read.mockResolvedValue(
      row({ askedText: "Подписать анкету на стр. 1?", askedVerbatim: false })
    );
    expect((await call(yes, confirmInput)).result).toMatchObject({
      status: "confirmation_required",
    });
    services.judge.mockResolvedValue({ output: { matches: true } });
    expect((await call(yes, confirmInput)).result).toMatchObject({
      status: "signed",
    });
  });

  it("does not take «да, но …» for consent, and takes «нет» for a no", async () => {
    expect(
      (
        await call(
          [...asked, person("да, но дату поставь вчерашнюю")],
          confirmInput
        )
      ).result
    ).toMatchObject({ status: "confirmation_required" });
    expect(
      (await call([...asked, person("нет")], confirmInput)).result
    ).toMatchObject({ status: "declined" });
    expect(services.cancel).toHaveBeenCalledOnce();
    expect(stampRuns()).toHaveLength(0);
  });

  it("after a cancel on «да, но …» asks to prepare again, and after «нет» not to offer again", async () => {
    services.cancel.mockResolvedValue(true);
    const cancelInput = { action: "cancel" as const, signingId };
    const butYes = await call(
      [...asked, person("да, но поставь вчерашнюю дату")],
      cancelInput
    );
    expect(butYes.result).toMatchObject({ status: "cancelled" });
    expect(z.object({ reply: z.string() }).parse(butYes.result).reply).toMatch(
      /prepare again/u
    );
    const no = await call([...asked, person("нет")], cancelInput);
    expect(z.object({ reply: z.string() }).parse(no.result).reply).toMatch(
      /do not offer again/u
    );
    // The report turn cancels a question naming another party's place: the
    // helper's new file, not this one prepared again.
    const report = await call(
      [person("Заполни анкету и подпиши"), taskReport],
      cancelInput,
      { opened: "background-message" }
    );
    expect(z.object({ reply: z.string() }).parse(report.result).reply).toMatch(
      /Do not prepare this file again unchanged/u
    );
  });

  it("asks to send the file with the question when it did not reach the person first", async () => {
    services.read.mockResolvedValue(row({ shownAt: null }));
    expect((await call(yes, confirmInput)).result).toMatchObject({
      attachUrl: link,
      status: "not_shown",
    });
    // Sent only after the question, as late as this turn.
    services.read.mockResolvedValue(row({ shownAt: new Date() }));
    expect((await call(yes, confirmInput)).result).toMatchObject({
      status: "not_shown",
    });
    expect(stampRuns()).toHaveLength(0);
  });

  it.each([
    ["expired", { expiresAt: new Date(Date.now() - 1000) }],
    ["date_changed", { dateText: "01.01.2020" }],
    [
      "signature_changed",
      { signatureId: "1d6f5d78-641b-4c80-aacf-eec05af14e53" },
    ],
    ["changed", { sourceSha256: "f".repeat(64) }],
  ] as const)(
    "asks again when the terms changed: %s",
    async (status, change) => {
      services.read.mockResolvedValue(row(change));
      expect((await call(yes, confirmInput)).result).toMatchObject({ status });
      expect(stampRuns()).toHaveLength(0);
    }
  );

  it("leaves a signing another confirm holds", async () => {
    services.claim.mockResolvedValue({ kind: "busy" });
    expect((await call(yes, confirmInput)).result).toMatchObject({
      status: "busy",
    });
    expect(stampRuns()).toHaveLength(0);
  });

  it("answers a replay after the signing with the same file", async () => {
    services.read.mockResolvedValue(
      row({
        confirmCallId: "call-1",
        outputUrl: signedUrl,
        signedAt: new Date(),
        status: "signed",
      })
    );
    expect((await call(yes, confirmInput)).result).toMatchObject({
      status: "signed",
      url: signedUrl,
    });
    expect(stampRuns()).toHaveLength(0);
  });

  it("gives the signing back when the stamp fails", async () => {
    services.kit.mockImplementation(
      async (_box, _dir, args): ReturnType<typeof runFreshKit> =>
        args[1] === "stamp-sign"
          ? { exitCode: 1, json: { code: "bug", ok: false }, stderr: "boom" }
          : { exitCode: 0, json: inventory, stderr: "" }
    );
    expect((await call(yes, confirmInput)).result).toMatchObject({
      status: "failed",
    });
    expect(services.release).toHaveBeenCalledWith({
      callId: "call-1",
      id: signingId,
    });
    expect(services.settle).not.toHaveBeenCalled();
  });

  it("saves the photo's sample on the yes and signs with it", async () => {
    services.summary.mockResolvedValue(null);
    services.sample.mockResolvedValue(null);
    services.read.mockResolvedValue(
      row({
        signaturePhotoPath: photoPath,
        signaturePngSha256: sha256(signaturePng),
        signatureSource: "photo",
      })
    );
    expect((await call(yes, confirmInput)).result).toMatchObject({
      status: "signed",
    });
    expect(services.save).toHaveBeenCalledWith(
      scope,
      { kind: "image", png: signaturePng },
      sampleId
    );
  });

  it("signs a second document from the same photo after the first saved its sample, never with another", async () => {
    const firstId = "2d6f5d78-641b-4c80-aacf-eec05af14e53";
    services.summary.mockResolvedValue({
      id: firstId,
      kind: "image",
      savedAt: new Date(),
    });
    services.sample.mockResolvedValue({
      id: firstId,
      kind: "image",
      png: signaturePng,
    });
    services.read.mockResolvedValue(
      row({
        signaturePhotoPath: photoPath,
        signaturePngSha256: sha256(signaturePng),
        signatureSource: "photo",
      })
    );
    expect((await call(yes, confirmInput)).result).toMatchObject({
      status: "signed",
    });
    expect(services.save).not.toHaveBeenCalled();
    services.sample.mockResolvedValue({
      id: firstId,
      kind: "image",
      png: png(600, 200),
    });
    expect((await call(yes, confirmInput)).result).toMatchObject({
      status: "signature_changed",
    });
  });
});

describe("where the tool is offered", () => {
  it("is not offered outside the pilot", async () => {
    services.pilot.on = false;
    expect(await resolve(yes)).toBeUndefined();
  });

  it("is offered in a scheduled report's turn too, with the same schema", async () => {
    const own = await resolve(yes);
    const report = await resolve(yes, "scheduled-result");
    expect(report).toBeDefined();
    expect(report?.description).toBe(own?.description);
  });
});
