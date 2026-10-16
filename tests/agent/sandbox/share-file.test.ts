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
      `Итоги.pptx was not shared: too much text on a slide (slide 2: 112 words; slide 3: 129 words).`
    );
    expect(storage.shareSandboxFile).not.toHaveBeenCalled();

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

  it("types a calendar invitation by its name", async () => {
    const invitation = new TextEncoder().encode("BEGIN:VCALENDAR\r\n");
    expect(
      await share(servedFile(1, invitation).stream, "/workspace/meeting.ics")
    ).toMatchObject({ mediaType: "text/calendar", name: "meeting.ics" });
  });
});

function toolContext(stream: ReadableStream<Uint8Array>) {
  const sandbox: Pick<SandboxSession, "readFile"> = {
    readFile: async () => Promise.resolve(stream),
  };
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    async getSandbox() {
      // SAFETY: The tool only reads the file's stream from the sandbox.
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
