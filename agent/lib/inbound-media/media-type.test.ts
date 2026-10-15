import { describe, expect, it } from "vitest";
import {
  documentBytesMatch,
  documentMediaType,
  resolveMediaType,
  sniffMediaType,
  textDocumentLooksLikeAudio,
  unsupportedArchive,
} from "./media-type";
import { odfPackage, ooxmlPackage } from "@tests/helpers/office-package";
import { zipWith } from "@tests/helpers/zip-archive";

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
    ["image/webp", tagged("RIFF", 8, "WEBP")],
    ["audio/wav", tagged("RIFF", 8, "WAVE")],
    ["audio/x-caf", padded([0x63, 0x61, 0x66, 0x66])],
    ["audio/mpeg", padded([0xff, 0xfb, 0x90, 0x00])],
    ["audio/aac", padded([0xff, 0xf1, 0x50, 0x80])],
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
});

const xlsxType =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("documents for the task agent", () => {
  it.each([
    ["Отчёт.XLSX", undefined, xlsxType],
    ["book.xls", "application/octet-stream", "application/vnd.ms-excel"],
    ["data.csv", "application/vnd.ms-excel", "text/csv"],
    ["notes.md", "text/x-markdown", "text/markdown"],
  ])("takes %s declared as %s", (name, declared, mediaType) => {
    expect(documentMediaType(name, declared)).toEqual(mediaType);
  });

  it.each([
    ["a.zip", "application/zip"],
    ["book.xlsx", "application/x-msdownload"],
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

describe("archives for the task agent", () => {
  const archive = zipWith({ entries: [{ content: "a", name: "a.txt" }] });
  const bomb = zipWith({
    entries: [{ content: "0", declaredSize: 300 * 1024 * 1024, name: "z" }],
  });

  it("takes a ZIP only where the caller asks for archives", () => {
    expect(documentMediaType("Архив.ZIP", "application/zip")).toBeUndefined();
    expect(
      documentMediaType("Архив.ZIP", "application/x-zip-compressed", {
        archives: true,
      })
    ).toBe("application/zip");
    // A ZIP's type speaks for no other extension.
    expect(
      documentMediaType("data.csv", "application/zip", { archives: true })
    ).toBeUndefined();
  });

  it("believes a ZIP whose directory reads within its limits", () => {
    expect(documentBytesMatch("application/zip", archive)).toBe(true);
    expect(documentBytesMatch("application/zip", bomb)).toBe(false);
  });

  it("names RAR and 7z as archives the task agent cannot open", () => {
    expect(unsupportedArchive("сканы.rar", undefined)).toBe(true);
    expect(unsupportedArchive("file", "application/x-7z-compressed")).toBe(
      true
    );
    expect(unsupportedArchive("сканы.zip", "application/zip")).toBe(false);
  });
});
