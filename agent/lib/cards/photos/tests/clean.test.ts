import { describe, expect, it } from "vitest";
import { cleanPhoto } from "../clean";
import {
  ascii,
  cameraText,
  contains,
  exifBlock,
  gpsText,
  jpeg,
  joined,
  png,
  scanData,
  webp,
  xmpText,
} from "./images";

function cleaned(bytes: Uint8Array) {
  const photo = cleanPhoto(bytes);
  if (photo.kind !== "photo") throw new Error(`Refused: ${photo.reason}`);
  return photo;
}

const orientationOnly = (orientation: number) =>
  joined(
    [0xff, 0xe1, 0x00, 0x22],
    ascii("Exif\0\0MM\0*\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0"),
    [orientation, 0, 0, 0, 0, 0, 0]
  );

describe("a JPEG for a card", () => {
  it("loses its EXIF, XMP, IPTC and comments, and keeps what draws it", () => {
    const photo = cleaned(jpeg({ height: 600, width: 800 }));

    expect(photo).toMatchObject({
      height: 600,
      mediaType: "image/jpeg",
      width: 800,
    });
    for (const gone of [gpsText, cameraText, xmpText, "Photoshop", "Exif"]) {
      expect(contains(photo.bytes, gone)).toBe(false);
    }
    for (const kept of ["JFIF", "ICC_PROFILE", "Adobe"]) {
      expect(contains(photo.bytes, kept)).toBe(true);
    }
    expect(contains(photo.bytes, new Uint8Array(scanData))).toBe(true);
    expect([...photo.bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    expect([...photo.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
  });

  it("keeps a turned photo's orientation as the only EXIF tag, read in either byte order", () => {
    const big = cleaned(jpeg({ height: 600, orientation: 6, width: 800 }));
    expect(contains(big.bytes, orientationOnly(6))).toBe(true);
    expect(contains(big.bytes, gpsText)).toBe(false);

    const little = jpeg({ height: 600, width: 800 });
    const withLittle = joined(
      little.subarray(0, 2),
      [0xff, 0xe1, 0, exifBlock(8, "II").byteLength + 2],
      exifBlock(8, "II"),
      little.subarray(2)
    );
    expect(contains(cleaned(withLittle).bytes, orientationOnly(8))).toBe(true);
  });

  it("writes no EXIF at all for a photo that stands upright", () => {
    const photo = cleaned(jpeg({ height: 600, orientation: 1, width: 800 }));
    expect(contains(photo.bytes, "Exif")).toBe(false);
  });

  it("drops what a file carries past its end", () => {
    const photo = cleaned(
      jpeg({
        height: 600,
        tail: [0xff, 0xd9, ...ascii("PK\x03\x04hidden")],
        width: 800,
      })
    );
    expect(contains(photo.bytes, "hidden")).toBe(false);
  });

  it("refuses a file cut short or with a segment past its end", () => {
    expect(cleanPhoto(jpeg({ height: 600, tail: [], width: 800 }))).toEqual({
      kind: "refused",
      reason: "malformed",
    });
    const broken = jpeg({ height: 600, width: 800 });
    broken.set([0xff, 0xdb, 0xff, 0xff], broken.byteLength - 20);
    expect(cleanPhoto(broken)).toMatchObject({ reason: "malformed" });
  });
});

describe("a PNG for a card", () => {
  it("loses its text, EXIF, XMP and time chunks and anything past IEND", () => {
    const photo = cleaned(png({ height: 480, width: 640 }));

    expect(photo).toMatchObject({
      height: 480,
      mediaType: "image/png",
      width: 640,
    });
    for (const gone of [
      gpsText,
      cameraText,
      xmpText,
      "tEXt",
      "eXIf",
      "iTXt",
      "tIME",
      "TRAILING",
    ]) {
      expect(contains(photo.bytes, gone)).toBe(false);
    }
    for (const kept of ["IHDR", "iCCP", "pHYs", "IDAT", "IEND"]) {
      expect(contains(photo.bytes, kept)).toBe(true);
    }
  });

  it("refuses one without its end", () => {
    expect(
      cleanPhoto(png({ end: false, height: 480, width: 640 }))
    ).toMatchObject({
      reason: "malformed",
    });
  });
});

describe("a WebP for a card", () => {
  it("loses its EXIF and XMP chunks and their flags, and says its new size", () => {
    const photo = cleaned(webp({ height: 600, width: 800 }));

    expect(photo).toMatchObject({
      height: 600,
      mediaType: "image/webp",
      width: 800,
    });
    expect(contains(photo.bytes, gpsText)).toBe(false);
    expect(contains(photo.bytes, xmpText)).toBe(false);
    expect(contains(photo.bytes, "ICCP")).toBe(true);
    const view = new DataView(photo.bytes.buffer);
    expect(view.getUint32(4, true)).toBe(photo.bytes.byteLength - 8);
    expect((photo.bytes[20] ?? 0) & 0x0c).toBe(0);
    expect((photo.bytes[20] ?? 0) & 0x20).toBe(0x20);
  });

  it("refuses one whose RIFF says it is longer than it is", () => {
    expect(
      cleanPhoto(webp({ height: 600, riffSlack: 40, width: 800 }))
    ).toMatchObject({
      reason: "malformed",
    });
  });
});

describe("what a card does not show", () => {
  it.each([
    ["a GIF", ascii("GIF89a\x20\x03\x58\x02\0\0\0\0")],
    [
      "a page served as a photo",
      ascii("<!doctype html><html><body>photo</body></html>"),
    ],
    ["an SVG", ascii('<svg xmlns="http://www.w3.org/2000/svg" width="800"/>')],
  ])("refuses %s by its bytes", (_name, bytes) => {
    expect(cleanPhoto(bytes)).toEqual({
      kind: "refused",
      reason: "unsupported",
    });
  });

  it("refuses a photo whose shorter side is under 200 px, and one too large to decode on a phone", () => {
    expect(cleanPhoto(jpeg({ height: 900, width: 199 }))).toMatchObject({
      reason: "too-small",
    });
    expect(cleanPhoto(png({ height: 150, width: 1200 }))).toMatchObject({
      reason: "too-small",
    });
    expect(cleanPhoto(jpeg({ height: 200, width: 200 }))).toMatchObject({
      kind: "photo",
    });
    expect(cleanPhoto(jpeg({ height: 6000, width: 8000 }))).toMatchObject({
      reason: "too-large",
    });
  });
});
