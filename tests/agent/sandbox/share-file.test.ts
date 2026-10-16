import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Files from "@agent/lib/sandbox/files";
import shareFile from "@agent/subagents/task/tools/share_file";
import { zipWith } from "@tests/helpers/zip-archive";

const stateControls = vi.hoisted(() => ({
  // SAFETY: The array is populated only with zero-argument reset callbacks created by this mock.
  reset: [] as (() => void)[],
}));

vi.mock("eve/context", () => ({
  defineState<T>(_name: string, initial: () => T) {
    let value = initial();
    stateControls.reset.push(() => {
      value = initial();
    });
    return {
      get: () => value,
      update(update: (current: T) => T) {
        value = update(value);
      },
    };
  },
}));

const storage = vi.hoisted(() => ({
  shareSandboxFile: vi.fn<typeof Files.shareSandboxFile>(),
}));
const pilot = vi.hoisted(() => ({
  taskFilesOfCaller: vi.fn<() => boolean>(() => false),
}));
/** The task sandbox's process runner, where `brokit check` runs. */
const kit = vi.hoisted(() => ({
  run: vi.fn<
    (options: {
      readonly env?: Record<string, string>;
    }) => Promise<{ exitCode: number; stderr: string; stdout: string }>
  >(),
}));

vi.mock("@agent/lib/sandbox/files", async (importOriginal) => ({
  ...(await importOriginal<typeof Files>()),
  shareSandboxFile: storage.shareSandboxFile,
}));
vi.mock("@agent/lib/sandbox/pilot", () => pilot);

type SandboxSession = Awaited<ReturnType<ToolContext["getSandbox"]>>;

beforeEach(() => {
  vi.clearAllMocks();
  for (const reset of stateControls.reset) reset();
  pilot.taskFilesOfCaller.mockReturnValue(false);
  kit.run.mockResolvedValue(checked([]));
  storage.shareSandboxFile.mockImplementation(async (input) => {
    // The store keeps its own cap, 10 MB unless the caller raises it.
    if (input.bytes.byteLength > (input.maximumBytes ?? 10 * 1024 * 1024)) {
      throw new Error("A shared file is over the store's cap.");
    }
    return await Promise.resolve({
      bytes: input.bytes.byteLength,
      mediaType: input.mediaType,
      name: input.name,
      url: "https://bro.example.test/eve/v1/sandbox-files/x/y?sig=z",
    });
  });
});

/** What `brokit check` prints for a file with these problems. */
function checked(
  problems: readonly { code: string; fix: string; where: string }[]
) {
  return {
    exitCode: 0,
    stderr: "",
    stdout: `${JSON.stringify({ file: "/workspace/x", kind: "xlsx", ok: true, problems })}\n`,
  };
}

/** The arguments the kit ran with, as runKit passes them (BROKIT_ARGS). */
function kitArguments() {
  return kit.run.mock.calls.map(([options]) => options.env?.BROKIT_ARGS);
}

/** A file the sandbox serves in chunks of a megabyte, `chunks` of them. */
function servedFile(chunks: number, first = new Uint8Array(0)) {
  let sent = 0;
  const cancel = vi.fn<() => void>();
  const stream = new ReadableStream<Uint8Array>({
    cancel,
    pull: (controller) => {
      if (sent === chunks) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(1024 * 1024).fill(7);
      if (sent === 0) chunk.set(first);
      controller.enqueue(chunk);
      sent += 1;
    },
  });
  return { cancel, sent: () => sent, stream };
}

async function share(stream: ReadableStream<Uint8Array>, path: string) {
  return await shareFile.execute({ path }, toolContext(stream));
}

/** A run of `count` distinct words. */
function words(count: number) {
  return Array.from({ length: count }, (_, at) => `пункт${String(at)}`).join(
    " "
  );
}

/** A slide's DrawingML: a shape whose paragraphs each hold their runs. */
function slide(...paragraphs: readonly (readonly string[])[]) {
  const body = paragraphs
    .map(
      (runs) =>
        `<a:p><a:pPr lvl="0"/>${runs.map((run) => `<a:r><a:rPr lang="ru-RU"/><a:t>${run}</a:t></a:r>`).join("")}</a:p>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/>${body}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}

/**
 * A .pptx as python-pptx writes it, deflated: the presentation lists its
 * slides by relationship, in the order `files` gives them.
 */
function deck(files: readonly string[], slides: Record<string, string>) {
  const listed = files
    .map(
      (file, at) =>
        `<p:sldId id="${String(256 + at)}" r:id="rId${String(at + 2)}"/>`
    )
    .join("");
  const relationships = files
    .map(
      (file, at) =>
        `<Relationship Id="rId${String(at + 2)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/${file}"/>`
    )
    .join("");
  return zipWith({
    entries: [
      { content: "<Types/>", deflated: true, name: "[Content_Types].xml" },
      {
        content: `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${listed}</p:sldIdLst></p:presentation>`,
        deflated: true,
        name: "ppt/presentation.xml",
      },
      {
        content: `<Relationships>${relationships}</Relationships>`,
        deflated: true,
        name: "ppt/_rels/presentation.xml.rels",
      },
      ...Object.entries(slides).map(([name, content]) => ({
        content,
        deflated: true,
        name,
      })),
    ],
  });
}

/** A file the sandbox serves whole. */
function served(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Bytes of a workbook: what they hold is the kit's to read, not the tool's. */
const workbook = new TextEncoder().encode("PK workbook");

/**
 * Slides shown in another order than their files: the title, then 112
 * words in two paragraphs, then 129 with a word split across runs and a
 * line of bullets, which makes no word. Its notes hold 300.
 */
const crowdedDeck = deck(["slide3.xml", "slide1.xml", "slide2.xml"], {
  "ppt/notesSlides/notesSlide2.xml": slide([words(300)]),
  "ppt/slides/slide1.xml": slide([words(60)], [words(52)]),
  "ppt/slides/slide2.xml": slide(
    ["Выру", "чка ", "выросла"],
    ["— • –"],
    [words(127)]
  ),
  "ppt/slides/slide3.xml": slide(["Итоги квартала"]),
});

describe("share_file", () => {
  it("stops reading a file that runs past 10 MB, however it grew", async () => {
    // As if the file was small when named, and a process kept writing.
    const file = servedFile(500);
    await expect(share(file.stream, "/workspace/log.txt")).rejects.toThrow(
      "is over 10 MB"
    );
    expect(file.sent()).toBeLessThan(20);
    expect(file.cancel).toHaveBeenCalledOnce();
    expect(storage.shareSandboxFile).not.toHaveBeenCalled();
  });

  it("shares a file of 15 MB in the files pilot", async () => {
    pilot.taskFilesOfCaller.mockReturnValue(true);
    const file = servedFile(15);

    await expect(
      share(file.stream, "/workspace/scan.pdf")
    ).resolves.toMatchObject({ bytes: 15 * 1024 * 1024 });
    await expect(
      share(servedFile(25).stream, "/workspace/huge.pdf")
    ).rejects.toThrow("is over 20 MB");
  });

  it("types a file by its bytes first, and by its name when they do not tell", async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect(
      await share(servedFile(1, new Uint8Array(png)).stream, "chart.txt")
    ).toMatchObject({ mediaType: "image/png", name: "chart.txt" });
    const zip = [0x50, 0x4b, 0x03, 0x04];
    expect(
      await share(servedFile(1, new Uint8Array(zip)).stream, "deck.pptx")
    ).toMatchObject({
      mediaType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
  });

  it("holds a deck with crowded slides back once, then shares the same bytes", async () => {
    await expect(
      share(served(crowdedDeck), "/workspace/Итоги.pptx")
    ).rejects.toThrow(
      "Итоги.pptx was not shared: the check found what to fix first.\n- dense_slides (slide 2: 112 words; slide 3: 129 words): a slide holds a heading and 3–5 short points, at most 80 words: move the details to the speaker notes.\nFix it and call share_file again.\nIf the person asked for it as it is, call share_file once more on the same file: it goes out as it is."
    );
    expect(storage.shareSandboxFile).not.toHaveBeenCalled();
    // Outside the files pilot the sandbox holds no kit: the deck's words are counted here.
    expect(kit.run).not.toHaveBeenCalled();

    await expect(
      share(served(crowdedDeck), "/workspace/Итоги.pptx")
    ).resolves.toMatchObject({ name: "Итоги.pptx" });
    expect(storage.shareSandboxFile).toHaveBeenCalledOnce();
  });

  it("shares a deck of short slides at once, and a crowded one that is no .pptx", async () => {
    const short = deck(["slide1.xml"], {
      "ppt/slides/slide1.xml": slide([words(80)]),
    });
    await expect(
      share(served(short), "/workspace/deck.pptx")
    ).resolves.toMatchObject({ name: "deck.pptx" });
    await expect(
      share(served(crowdedDeck), "/workspace/deck.zip")
    ).resolves.toMatchObject({ mediaType: "application/zip" });
  });

  it("checks no workbook or PDF outside the files pilot", async () => {
    await expect(
      share(served(workbook), "/workspace/Итоги.xlsx")
    ).resolves.toMatchObject({ name: "Итоги.xlsx" });
    expect(kit.run).not.toHaveBeenCalled();
  });

  it("types a calendar invitation by its name", async () => {
    const invitation = new TextEncoder().encode("BEGIN:VCALENDAR\r\n");
    expect(
      await share(servedFile(1, invitation).stream, "/workspace/meeting.ics")
    ).toMatchObject({ mediaType: "text/calendar", name: "meeting.ics" });
  });
});

describe("share_file's check in the files pilot", () => {
  beforeEach(() => {
    pilot.taskFilesOfCaller.mockReturnValue(true);
  });

  it("holds a workbook back once for what brokit check names, then shares the same bytes", async () => {
    const longPlace = `Операции!A (999 cells like 01.01.2025)${"!".repeat(400)}`;
    kit.run.mockResolvedValue(
      checked([
        {
          code: "not_recalculated",
          fix: "brokit xlsx recalc FILE -o OUT computes every formula and names the ones that give an error; share OUT",
          where: "39 formula cells without a computed value: Итоги!B4",
        },
        {
          code: "text_dates",
          fix: "write datetime values into these cells with number_format 'DD.MM.YYYY' (or 'DD.MM.YYYY hh:mm'), not text",
          where: longPlace,
        },
      ])
    );
    await expect(share(served(workbook), "Отчёт.xlsx")).rejects.toThrow(
      new Error(
        [
          "Отчёт.xlsx was not shared: the check found what to fix first.",
          "- not_recalculated (39 formula cells without a computed value: Итоги!B4): brokit xlsx recalc FILE -o OUT computes every formula and names the ones that give an error; share OUT.",
          // A long place is cut, so a sheet of names cannot fill the model's step.
          `- text_dates (${longPlace.slice(0, 300)}…): write datetime values into these cells with number_format 'DD.MM.YYYY' (or 'DD.MM.YYYY hh:mm'), not text.`,
          "Fix it, check the result with look and call share_file again.",
          "If the person asked for it as it is, call share_file once more on the same file: it goes out as it is.",
        ].join("\n")
      )
    );
    // A relative path goes as it is: the kit runs in /workspace, as readFile reads.
    expect(kitArguments()).toStrictEqual([
      JSON.stringify(["check", "Отчёт.xlsx"]),
    ]);
    expect(storage.shareSandboxFile).not.toHaveBeenCalled();

    await expect(share(served(workbook), "Отчёт.xlsx")).resolves.toMatchObject({
      name: "Отчёт.xlsx",
    });
    // The same bytes are not checked again.
    expect(kit.run).toHaveBeenCalledOnce();
    expect(storage.shareSandboxFile).toHaveBeenCalledOnce();
  });

  it("shares a file brokit check finds clean at once", async () => {
    await expect(
      share(served(workbook), "/workspace/Итоги.xlsx")
    ).resolves.toMatchObject({ name: "Итоги.xlsx" });
    await expect(
      share(served(crowdedDeck), "/workspace/Итоги.pptx")
    ).resolves.toMatchObject({ name: "Итоги.pptx" });
    // The kit counted the deck's words: they are not counted again here.
    expect(kitArguments()).toStrictEqual([
      JSON.stringify(["check", "/workspace/Итоги.xlsx"]),
      JSON.stringify(["check", "/workspace/Итоги.pptx"]),
    ]);
  });

  it("shares the file when the check itself fails, and logs no text of it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failures = [
      async () => Promise.reject(new Error("The sandbox stopped: Итоги")),
      async () =>
        Promise.resolve({
          exitCode: 1,
          stderr: "brokit: TypeError: Итоги",
          stdout: '{"ok":false,"code":"bug","error":"TypeError: Итоги"}\n',
        }),
      async () =>
        Promise.resolve({ exitCode: 0, stderr: "", stdout: "Итоги\n" }),
    ];
    for (const [index, failure] of failures.entries()) {
      kit.run.mockImplementationOnce(failure);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each failure is shared on its own.
      await expect(
        share(served(new Uint8Array([index + 1])), "/workspace/Итоги.pdf")
      ).resolves.toMatchObject({ name: "Итоги.pdf" });
    }
    expect(storage.shareSandboxFile).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Итоги");
    expect(warn.mock.calls).toStrictEqual([
      ["[share_file] the file check failed", { cause: "Error" }],
      ["[share_file] the file check failed", { code: "bug", exitCode: 1 }],
      [
        "[share_file] the file check failed",
        { code: "no output", exitCode: 0 },
      ],
    ]);
    warn.mockRestore();
  });

  it("counts a deck's slides itself when the check fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    kit.run.mockRejectedValue(new Error("no kit"));
    await expect(
      share(served(crowdedDeck), "/workspace/Итоги.pptx")
    ).rejects.toThrow(
      "- dense_slides (slide 2: 112 words; slide 3: 129 words)"
    );
    vi.mocked(console.warn).mockRestore();
  });
});

function toolContext(stream: ReadableStream<Uint8Array>) {
  const sandbox: Pick<SandboxSession, "readFile" | "run" | "writeTextFile"> = {
    readFile: async () => Promise.resolve(stream),
    run: kit.run,
    writeTextFile: async () => {
      throw new Error("The kit is delivered outside this focused test.");
    },
  };
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    async getSandbox() {
      // SAFETY: The tool reads the file's stream and runs the kit's check in the sandbox.
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
      auth: { current: null, initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "share_file",
  } satisfies ToolContext;
}
