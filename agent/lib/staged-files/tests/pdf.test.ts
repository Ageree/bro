import { describe, expect, it } from "vitest";
import { pdfFacts } from "../pdf";

function pdf(body: string) {
  return new Uint8Array(Buffer.from(`%PDF-1.7\n${body}\n%%EOF\n`, "latin1"));
}

describe("pdfFacts", () => {
  it("finds the encryption dictionary a trailer names, not the word in text", () => {
    expect(
      pdfFacts(pdf("trailer << /Size 6 /Encrypt 5 0 R /Root 1 0 R >>"))
        .encrypted
    ).toBe(true);
    expect(pdfFacts(pdf("BT (/Encrypt) Tj ET")).encrypted).toBe(false);
  });

  it("counts pages by the page tree, else by the page objects", () => {
    expect(
      pdfFacts(
        pdf(
          "2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >> endobj"
        )
      ).pages
    ).toBe(3);
    expect(
      pdfFacts(
        pdf(
          "3 0 obj << /Type /Page /Parent 2 0 R >> endobj 4 0 obj << /Type /Page >> endobj"
        )
      ).pages
    ).toBe(2);
  });

  it("does not guess the pages of a tree inside an object stream", () => {
    expect(
      pdfFacts(pdf("7 0 obj << /Type /ObjStm /N 4 /Length 99 >> stream x"))
        .pages
    ).toBeUndefined();
  });
});
