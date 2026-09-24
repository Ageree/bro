import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { caseFixtures } from "../../bench/fixtures.ts";
import { messageContent } from "../../bench/media.ts";

vi.mock("@agent/lib/inbound-media/transcription", () => ({
  transcribeAudio: () =>
    Promise.resolve({
      kind: "transcript",
      model: "test-stt",
      text: "запиши меня завтра в барбершоп",
    }),
}));

describe("messageContent", () => {
  it("sends plain text as a string, like the web chat", async () => {
    await expect(messageContent("привет", [], [])).resolves.toBe("привет");
  });

  it("attaches photos as data-URL file parts next to the text", async () => {
    const files = caseFixtures.get("d08-utilities")?.files ?? [];
    const content = await messageContent("вот показания", files, []);

    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) return;
    expect(content[0]).toEqual({ text: "вот показания", type: "text" });
    expect(content).toHaveLength(4);
    for (const part of content.slice(1)) {
      expect(part).toMatchObject({ mediaType: "image/png", type: "file" });
      expect(part).toHaveProperty(
        "data",
        expect.stringMatching(/^data:image\/png;base64,/u)
      );
    }
  });

  it("sniffs an attachment's type from its bytes", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "bench-media-")), "scan");
    await writeFile(path, Buffer.from("%PDF-1.7\n%test\n"));
    const content = await messageContent("", [{ path }], []);

    expect(content).toEqual([
      expect.objectContaining({ mediaType: "application/pdf", type: "file" }),
    ]);
  });

  it("turns a voice note into the transcript line the messengers send", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "bench-media-")), "v.ogg");
    await writeFile(path, Buffer.from("OggS"));

    await expect(messageContent("", [], [path])).resolves.toBe(
      "[голосовое] запиши меня завтра в барбершоп"
    );
  });
});
