import { mkdtemp, truncate, writeFile } from "node:fs/promises";
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

  it("sends a photo past the thumbnails' budget as its bare base64", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "bench-media-")), "a.jpg");
    const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
    bytes.set([0xff, 0xd8, 0xff, 0xe0]);
    await writeFile(path, bytes);

    expect(await messageContent("", [{ path }], [])).toEqual([
      {
        data: bytes.toString("base64"),
        filename: "a.jpg",
        mediaType: "image/jpeg",
        type: "file",
      },
    ]);
  });

  it("refuses what the web chat would refuse before sending anything", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bench-media-"));
    const big = join(directory, "big.pdf");
    await writeFile(big, "");
    await truncate(big, 20 * 1024 * 1024 + 1);
    await expect(messageContent("", [{ path: big }], [])).rejects.toThrow(
      /big\.pdf: .*413/u
    );

    const eleven = await Promise.all(
      Array.from({ length: 11 }, async (_, index) => {
        const path = join(directory, `${String(index)}.txt`);
        await writeFile(path, "строка");
        return { path };
      })
    );
    await expect(messageContent("", eleven, [])).rejects.toThrow(
      /10\.txt: больше 10 файлов/u
    );
  });

  it("turns a voice note into the transcript line the messengers send", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "bench-media-")), "v.ogg");
    await writeFile(path, Buffer.from("OggS"));

    await expect(messageContent("", [], [path])).resolves.toBe(
      "[голосовое] запиши меня завтра в барбершоп"
    );
  });
});
