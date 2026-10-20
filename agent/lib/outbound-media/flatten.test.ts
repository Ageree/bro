import { readPngRows, syntheticPng } from "@tests/helpers/synthetic-png";
import { describe, expect, it } from "vitest";
import { flattenedPng } from "./flatten";

/** One RGBA scanline of three pixels. */
const row = (...pixels: readonly (readonly number[])[]) => pixels.flat();

/** A colour seen through `alpha` over white. */
const blend = (value: number, alpha: number) =>
  Math.round((value * alpha + 255 * (255 - alpha)) / 255);

describe("a transparent PNG laid on white", () => {
  it("blends every pixel with white under each of the five row filters", async () => {
    const rows = [
      row([0, 0, 0, 0], [200, 100, 50, 255], [0, 0, 0, 128]),
      row([10, 20, 30, 0], [255, 0, 0, 255], [40, 80, 120, 64]),
      row([0, 255, 0, 255], [0, 0, 0, 0], [90, 90, 90, 200]),
      row([1, 2, 3, 4], [250, 240, 230, 220], [0, 0, 255, 255]),
      row([128, 64, 32, 16], [0, 0, 0, 255], [255, 255, 255, 0]),
    ];
    const flat = await flattenedPng(
      syntheticPng({ colorType: 6, filters: [0, 1, 2, 3, 4], rows })
    );
    expect(readPngRows(flat ?? Buffer.alloc(0))).toEqual({
      colorType: 2,
      rows: rows.map((line) =>
        line.flatMap((value, at) =>
          at % 4 === 3 ? [] : [blend(value, line[at - (at % 4) + 3] ?? 255)]
        )
      ),
    });
    expect(readPngRows(flat ?? Buffer.alloc(0)).rows[0]).toEqual([
      255, 255, 255, 200, 100, 50, 127, 127, 127,
    ]);
  });

  it("reads a PNG another encoder wrote, its data split in two chunks beside a text one", async () => {
    // Pillow's 10×6 RGBA picture under its own filters (Sub and Paeth), and
    // Pillow's own blend of it on white.
    const pillow = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAGCAYAAAD68A/GAAAAFnRFWHRDb21tZW50AG1hZGUgYnkgUGlsbG93CLB+ewAAAERJREFUeJxdjqENAlEQRHfDJSMmlPBxJ77BIagFeQpHQgP0cCXQDxZzDZzBjIaPmZ8QxGY3b14mmxEtCtdWuMbP5D8bUNVAnUAbj97eAAAARUlEQVSNoG6gEtQLVIA6mt8HVAWog0GC+vhezGdQrYsXS81Ni/fcWRcT1M7h2Y1XUE9Q70JtBlQlqL3D/sbkpi2oEVWPLwoGUkHkfCkDAAAAAElFTkSuQmCC",
      "base64"
    );
    const onWhite = Buffer.from(
      "////HQvoOhbRVyG6dCyj////rkJ1y01e6FhHBWMwBynysrfyoJ/iXkqt////n2uItWto9eHZ+dG3////DlLliKTkfpTM////gn+J8u/svJRb79av////E7UWFXvYMobB////bJyTiad8prJlw71O/////dMgGt4JHKTL////6/fzc8WG0uzE0uuj////6/NLB/wWIQf8////3fjvyvbbeu55v/ue////0Q80/vT00NXPKDDv",
      "base64"
    );
    const flat = await flattenedPng(pillow);
    expect(readPngRows(flat ?? Buffer.alloc(0))).toEqual({
      colorType: 2,
      rows: Array.from({ length: 6 }, (_, y) => [
        ...onWhite.subarray(y * 30, (y + 1) * 30),
      ]),
    });
  });

  it("turns grey with alpha into plain grey", async () => {
    const flat = await flattenedPng(
      syntheticPng({ colorType: 4, rows: [[0, 0, 100, 255, 0, 128]] })
    );
    expect(readPngRows(flat ?? Buffer.alloc(0))).toEqual({
      colorType: 0,
      rows: [[255, 100, 127]],
    });
  });

  it("leaves an opaque picture, an RGB one and what is not a PNG as they are", async () => {
    const opaque = syntheticPng({
      colorType: 6,
      rows: [row([1, 2, 3, 255], [4, 5, 6, 255])],
    });
    const rgb = syntheticPng({ colorType: 2, rows: [[1, 2, 3]] });
    await expect(flattenedPng(opaque)).resolves.toBeUndefined();
    await expect(flattenedPng(rgb)).resolves.toBeUndefined();
    await expect(
      flattenedPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))
    ).resolves.toBeUndefined();
  });

  it("leaves a PNG whose pixels are cut short as it is", async () => {
    const whole = syntheticPng({
      colorType: 6,
      rows: [row([0, 0, 0, 0], [0, 0, 0, 0])],
    });
    const taller = Buffer.from(whole);
    taller.writeUInt32BE(2, 20);
    await expect(flattenedPng(taller)).resolves.toBeUndefined();
  });
});
