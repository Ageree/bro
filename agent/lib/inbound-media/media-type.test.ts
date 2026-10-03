import { describe, expect, it } from "vitest";
import {
  baseMediaType,
  documentBytesMatch,
  documentMediaType,
  resolveMediaType,
  sniffMediaType,
  textDocumentLooksLikeAudio,
} from "./media-type";
import { odfPackage, ooxmlPackage } from "@tests/helpers/office-package";

function padded(prefix: readonly number[]) {
  const bytes = new Uint8Array(16);
  bytes.set(prefix);
  return bytes;
}

function tagged(head: string, brandOffset: number, brand: string) {
  const bytes = new Uint8Array(16);
  bytes.set(new TextEncoder().encode(head));
  bytes.set(new TextEncoder().encode(brand), brandOffset);
  return bytes;
}

describe("media type sniffing", () => {
  it.each([
    ["image/jpeg", padded([0xff, 0xd8, 0xff, 0xe0])],
    ["image/png", padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["image/gif", padded([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])],
    ["image/webp", tagged("RIFF", 8, "WEBP")],
    ["audio/wav", tagged("RIFF", 8, "WAVE")],
    ["application/pdf", padded([0x25, 0x50, 0x44, 0x46, 0x2d])],
    ["audio/x-caf", padded([0x63, 0x61, 0x66, 0x66])],
    ["audio/ogg", padded([0x4f, 0x67, 0x67, 0x53])],
    ["audio/mpeg", padded([0x49, 0x44, 0x33, 0x04])],
    ["audio/mpeg", padded([0xff, 0xfb, 0x90, 0x00])],
    ["audio/mpeg", padded([0xff, 0xf3, 0x90, 0x00])],
    ["audio/aac", padded([0xff, 0xf1, 0x50, 0x80])],
    ["audio/aac", padded([0xff, 0xf9, 0x50, 0x80])],
  ])("reads %s from the magic bytes", (mediaType, bytes) => {
    expect(sniffMediaType(bytes)).toBe(mediaType);
  });

  it("reads ISO base media brands for HEIC photos and m4a recordings", () => {
    expect(sniffMediaType(tagged("\0\0\0ftyp", 8, "heic"))).toBe("image/heic");
    expect(sniffMediaType(tagged("\0\0\0ftyp", 8, "M4A "))).toBe("audio/mp4");
    expect(sniffMediaType(tagged("\0\0\0ftyp", 8, "qt  "))).toBe(undefined);
  });

  it("gives up on short or unknown files", () => {
    expect(sniffMediaType(new Uint8Array([0xff, 0xd8]))).toBeUndefined();
    expect(sniffMediaType(new Uint8Array(32))).toBeUndefined();
  });

  it("falls back to the declared type only when the bytes say nothing", () => {
    const jpeg = padded([0xff, 0xd8, 0xff, 0xe0]);
    expect(resolveMediaType(jpeg, "application/octet-stream")).toBe(
      "image/jpeg"
    );
    expect(resolveMediaType(new Uint8Array(32), "Image/PNG; foo=bar")).toBe(
      "image/png"
    );
    expect(resolveMediaType(new Uint8Array(32), undefined)).toBeUndefined();
  });

  it("strips media type parameters", () => {
    expect(baseMediaType("audio/x-caf; codecs=opus")).toBe("audio/x-caf");
    expect(baseMediaType("  ")).toBeUndefined();
    expect(baseMediaType(null)).toBeUndefined();
  });
});

const xlsxType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("documents for the task agent", () => {
  it.each([
    ["Отчёт.XLSX", undefined, xlsxType],
    ["book.xlsx", "application/zip", xlsxType],
    ["book.xls", "application/octet-stream", "application/vnd.ms-excel"],
    ["data.csv", "application/vnd.ms-excel", "text/csv"],
    ["data.csv", "text/comma-separated-values", "text/csv"],
    [
      "deck.pptx",
      undefined,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    ["notes.md", "text/x-markdown", "text/markdown"],
    ["feed.xml", "text/xml", "application/xml"],
  ])("takes %s declared as %s", (name, declared, mediaType) => {
    expect(documentMediaType(name, declared)).toEqual(mediaType);
  });

  it.each([
    ["a.zip", "application/zip"],
    ["setup.exe", "application/x-msdownload"],
    ["clip.mp4", "video/mp4"],
    ["scan.pdf", "application/pdf"],
    ["photo.png", "image/png"],
    ["book.xlsx", "application/x-msdownload"],
    ["book.xlsx", "video/mp4"],
    ["data.csv", "application/zip"],
    ["xlsx", undefined],
    [".xlsx", undefined],
    [undefined, xlsxType],
  ])("leaves %s declared as %s a note", (name, declared) => {
    expect(documentMediaType(name, declared)).toBeUndefined();
  });

  it("believes the bytes only when they are the extension's container", () => {
    const zip = padded([0x50, 0x4b, 0x03, 0x04]);
    const cfb = padded([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const exe = padded([0x4d, 0x5a, 0x90, 0x00]);
    const csv = new TextEncoder().encode("дата;сумма\n01.10;100\n");

    expect(documentBytesMatch(xlsxType, ooxmlPackage())).toBe(true);
    // Any other zip renamed: no `[Content_Types].xml`.
    expect(documentBytesMatch(xlsxType, zip)).toBe(false);
    expect(documentBytesMatch(xlsxType, exe)).toBe(false);
    expect(documentBytesMatch(xlsxType, cfb)).toBe(false);
    expect(documentBytesMatch("application/vnd.ms-excel", cfb)).toBe(true);
    expect(documentBytesMatch("application/vnd.ms-excel", zip)).toBe(false);
    expect(documentBytesMatch("text/csv", csv)).toBe(true);
    expect(documentBytesMatch("text/csv", zip)).toBe(false);
    expect(documentBytesMatch("text/csv", padded([0xff, 0xfe, 0x41]))).toBe(
      true
    );
    expect(documentBytesMatch("application/zip", zip)).toBe(false);
  });

  it("believes an OpenDocument only with its own media type in the package", () => {
    const odsType = "application/vnd.oasis.opendocument.spreadsheet";
    const odtType = "application/vnd.oasis.opendocument.text";

    expect(documentBytesMatch(odsType, odfPackage(odsType))).toBe(true);
    expect(documentBytesMatch(odsType, odfPackage(odtType))).toBe(false);
    expect(documentBytesMatch(odsType, ooxmlPackage())).toBe(false);
    expect(documentBytesMatch(odsType, padded([0x50, 0x4b, 0x03, 0x04]))).toBe(
      false
    );
  });

  it("takes a text that only looks like audio for text", () => {
    const id3Text = new TextEncoder().encode("ID3 tags: заметки по формату\n");
    // A real tag carries its version as two bytes, the second always 0.
    const id3Audio = padded([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
    const utf16 = padded([0xff, 0xfe, 0x41, 0x00]);

    expect(sniffMediaType(id3Text)).toBe("audio/mpeg");
    expect(textDocumentLooksLikeAudio("text/markdown", id3Text)).toBe(true);
    expect(textDocumentLooksLikeAudio("text/csv", utf16)).toBe(true);
    expect(textDocumentLooksLikeAudio("text/markdown", id3Audio)).toBe(false);
    expect(textDocumentLooksLikeAudio(xlsxType, id3Text)).toBe(false);
  });
});
