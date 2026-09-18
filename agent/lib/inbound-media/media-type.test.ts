import { describe, expect, it } from "vitest";
import { baseMediaType, resolveMediaType, sniffMediaType } from "./media-type";

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
