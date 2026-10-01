import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Files from "@agent/lib/sandbox/files";
import shareFile from "@agent/subagents/task/tools/share_file";

const storage = vi.hoisted(() => ({
  shareSandboxFile: vi.fn<typeof Files.shareSandboxFile>(),
}));

vi.mock("@agent/lib/sandbox/files", async (importOriginal) => ({
  ...(await importOriginal<typeof Files>()),
  shareSandboxFile: storage.shareSandboxFile,
}));

type SandboxSession = Awaited<ReturnType<ToolContext["getSandbox"]>>;

beforeEach(() => {
  vi.clearAllMocks();
  storage.shareSandboxFile.mockImplementation(async (input) =>
    Promise.resolve({
      bytes: input.bytes.byteLength,
      mediaType: input.mediaType,
      name: input.name,
      url: "https://bro.example.test/eve/v1/sandbox-files/x/y?sig=z",
    })
  );
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
