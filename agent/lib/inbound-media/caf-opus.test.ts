import { describe, expect, it } from "vitest";
import {
  syntheticCafLpcm,
  syntheticCafOpus,
  syntheticOpusPacket,
} from "@tests/helpers/synthetic-caf";
import { cafCodec, cafOpusToOgg, isCaf } from "./caf-opus";

function oggPages(ogg: Uint8Array) {
  const pages: {
    readonly bodyLength: number;
    readonly granule: bigint;
    readonly segments: number;
  }[] = [];
  const view = new DataView(ogg.buffer, ogg.byteOffset, ogg.byteLength);
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
      const granule = view.getBigInt64(index + 6, true);
      pages.push({ bodyLength, granule, segments });
      index += 27 + segments + bodyLength;
    } else {
      index += 1;
    }
  }
  return pages;
}

/** The pre-skip the OpusHead packet on the first page declares. */
function preSkipOf(ogg: Uint8Array) {
  const head = Buffer.from(ogg).indexOf("OpusHead");
  return new DataView(ogg.buffer, ogg.byteOffset).getUint16(head + 10, true);
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

  it("keeps a recorded zero priming and defaults only without a packet table", () => {
    expect(preSkipOf(cafOpusToOgg(syntheticCafOpus()))).toBe(312);
    expect(
      preSkipOf(
        cafOpusToOgg(
          syntheticCafOpus({ packetTable: { priming: 0, remainder: 0 } })
        )
      )
    ).toBe(0);
    expect(
      preSkipOf(
        cafOpusToOgg(
          syntheticCafOpus({ bytesPerPacket: 3, packetTable: false })
        )
      )
    ).toBe(312);
  });

  it("slices a constant-size stream without a packet table into packets", () => {
    const two = syntheticCafOpus({
      bytesPerPacket: 3,
      packetTable: false,
      packets: [syntheticOpusPacket, syntheticOpusPacket],
    });
    const pages = oggPages(cafOpusToOgg(two));
    expect(pages).toHaveLength(4);
    expect(pages.map((page) => page.bodyLength).slice(2)).toEqual([3, 3]);
    expect(pages.map((page) => page.granule).slice(2)).toEqual([960n, 1920n]);

    const ragged = syntheticCafOpus({
      bytesPerPacket: 3,
      packetTable: false,
      packets: [syntheticOpusPacket, syntheticOpusPacket.subarray(0, 1)],
    });
    expect(() => cafOpusToOgg(ragged)).toThrow("caf packet remainder");
  });

  it("ends the stream before the encoder's remainder frames", () => {
    const ogg = cafOpusToOgg(
      syntheticCafOpus({
        packetTable: { priming: 312, remainder: 100 },
        packets: [syntheticOpusPacket, syntheticOpusPacket],
      })
    );
    expect(oggPages(ogg).map((page) => page.granule)).toEqual([
      0n,
      0n,
      960n,
      1820n,
    ]);
  });

  it("reads the code-3 frame count from the low six bits", () => {
    // TOC 0xff: 20 ms CELT frames, code 3; count byte 0x42: padding flag, two frames.
    const ogg = cafOpusToOgg(
      syntheticCafOpus({ packets: [new Uint8Array([0xff, 0x42, 0x00, 0x00])] })
    );
    expect(oggPages(ogg).at(-1)?.granule).toBe(1920n);
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
