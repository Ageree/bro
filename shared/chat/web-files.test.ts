import { describe, expect, it } from "vitest";
import { admitFiles, webMessageFiles } from "./web-files";

const mib = 1024 * 1024;

function file(name: string, type: string, size = 1) {
  return { name, size, type };
}

describe("web message files", () => {
  it.each([
    ["an exact type", "application/pdf", file("a.pdf", "application/pdf"), 1],
    [
      "an extension on a file the browser left untyped",
      ".pdf,.docx",
      file("Договор.DOCX", ""),
      1,
    ],
    ["a wildcard type", "image/*", file("p.png", "image/png"), 1],
    [
      "a type off the list",
      "image/jpeg,image/png,.jpg,.jpeg,.png",
      file("IMG.HEIC", "image/heic"),
      0,
    ],
  ])("matches %s", (_label, accept, candidate, admitted) => {
    expect(admitFiles([candidate], { accept }).admitted).toHaveLength(admitted);
  });

  it("admits what fits and names the most telling refusal", () => {
    const result = admitFiles(
      [
        file("a.pdf", "application/pdf", 5 * mib),
        file("setup.exe", "application/x-msdownload"),
        file("b.pdf", "application/pdf", 21 * mib),
        file("c.pdf", "application/pdf", 19 * mib),
        file("d.pdf", "application/pdf", 19 * mib),
      ],
      { accept: "application/pdf,.pdf", ...webMessageFiles }
    );

    expect(result.admitted.map((admitted) => admitted.name)).toEqual([
      "a.pdf",
      "c.pdf",
    ]);
    expect(result.refusal).toBe("accept");
  });

  it("counts the files the composer already holds", () => {
    const result = admitFiles(
      [file("a.jpg", "image/jpeg"), file("b.jpg", "image/jpeg")],
      { ...webMessageFiles, held: { bytes: 0, count: 9 } }
    );

    expect(result.admitted.map((admitted) => admitted.name)).toEqual(["a.jpg"]);
    expect(result.refusal).toBe("max_files");
  });
});
