import { describe, expect, it } from "vitest";
import {
  syntheticCafLpcm,
  syntheticCafOpus,
  syntheticOpusPacket,
} from "@tests/helpers/synthetic-caf";
import { cafCodec, cafOpusToOgg, isCaf } from "./caf-opus";

function oggPages(ogg: Uint8Array) {
  const pages: { readonly bodyLength: number; readonly segments: number }[] =
    [];
  let index = 0;
  while (index + 27 <= ogg.length) {
    if (
      ogg[index] === 0x4f &&
      ogg[index + 1] === 0x67 &&
      ogg[index + 2] === 0x67 &&
      ogg[index + 3] === 0x53
    ) {
      const segments = ogg[index + 26] ?? 0;
      let bodyLength = 0;
      for (let segment = 0; segment < segments; segment += 1) {
        bodyLength += ogg[index + 27 + segment] ?? 0;
      }
      pages.push({ bodyLength, segments });
      index += 27 + segments + bodyLength;
    } else {
      index += 1;
    }
  }
  return pages;
}

describe("CAF Opus remux", () => {
  it("recognises the container and its codec", () => {
    expect(isCaf(syntheticCafOpus())).toBe(true);
    expect(isCaf(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0]))).toBe(
      false
    );
    expect(cafCodec(syntheticCafOpus())).toBe("opus");
    expect(cafCodec(syntheticCafLpcm())).toBe("lpcm");
    expect(cafCodec(new Uint8Array(4))).toBeUndefined();
  });

  it("writes an Ogg stream with the Opus headers and one audio page", () => {
    const ogg = cafOpusToOgg(syntheticCafOpus());
    const text = Buffer.from(ogg).toString("latin1");

    expect(text.startsWith("OggS")).toBe(true);
    expect(text).toContain("OpusHead");
    expect(text).toContain("OpusTags");
    const pages = oggPages(ogg);
    expect(pages).toHaveLength(3);
    expect(pages[2]?.bodyLength).toBe(syntheticOpusPacket.length);
    const crc = new DataView(ogg.buffer, ogg.byteOffset).getUint32(22, true);
    expect(crc).not.toBe(0);
  });

  it("refuses a CAF file whose payload is not Opus", () => {
    expect(() => cafOpusToOgg(syntheticCafLpcm())).toThrow(
      "unsupported_caf_codec"
    );
  });

  it("refuses a truncated file", () => {
    expect(() => cafOpusToOgg(syntheticCafOpus().subarray(0, 40))).toThrow(
      /caf/u
    );
  });
});
