import { describe, expect, it } from "vitest";
import { zipWith } from "@tests/helpers/zip-archive";
import { inspectZip } from "./zip";

/**
 * What Python's `zipfile` wrote for «отчёт_2019.txt» in cp866 without the
 * UTF-8 flag, as Windows archivers still do.
 */
const cp866Zip = Buffer.from(
  "UEsDBBQAAAAAAAAAIQB3R9+OCgAAAAoAAAAUAAAAruLn8eJfMjAxOS50eHRfX19fX194eHh4eHh4eHh4UEsBAhQDFAAAAAAAAAAhAHdH344KAAAACgAAABQAAAAAAAAAAAAAAIABAAAAAK7i5/HiXzIwMTkudHh0X19fX19fUEsFBgAAAAABAAEAQgAAADwAAAAAAA==",
  "base64"
);

const megabytes = 1024 * 1024;

describe("inspectZip", () => {
  it("reads the entries of an archive and counts the encrypted ones", () => {
    expect(
      inspectZip(
        zipWith({
          entries: [
            { content: "дата;сумма", name: "выписка.csv" },
            { content: "secret", encrypted: true, name: "пароли.txt" },
          ],
        })
      )
    ).toEqual({
      encrypted: 1,
      entries: 2,
      kind: "zip",
      uncompressedBytes: 25,
    });
    expect(inspectZip(new Uint8Array(cp866Zip))).toMatchObject({
      entries: 1,
      kind: "zip",
    });
  });

  it("takes an empty archive", () => {
    expect(inspectZip(zipWith({ entries: [] }))).toMatchObject({
      entries: 0,
      kind: "zip",
    });
  });

  it("reads sizes and the directory from the ZIP64 records", () => {
    expect(
      inspectZip(
        zipWith({
          entries: [{ content: "y", declaredSize: 5000, name: "big.txt" }],
          zip64: true,
        })
      )
    ).toMatchObject({ entries: 1, kind: "zip", uncompressedBytes: 5000 });
  });

  it("refuses more than a thousand entries", () => {
    const entries = Array.from({ length: 1001 }, (_, index) => ({
      name: `f${String(index)}.txt`,
    }));
    expect(inspectZip(zipWith({ entries }))).toEqual({ kind: "too-many" });
  });

  it("refuses an archive that claims more than 256 MiB unpacked", () => {
    const bomb = zipWith({
      entries: [
        { content: "0", declaredSize: 200 * megabytes, name: "a.bin" },
        { content: "0", declaredSize: 100 * megabytes, name: "b.bin" },
      ],
    });
    expect(inspectZip(bomb)).toEqual({ kind: "too-large" });
  });

  it("calls an archive whose directory is elsewhere broken", () => {
    const bytes = zipWith({ entries: [{ content: "a", name: "a.txt" }] });
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    view.setUint32(bytes.byteLength - 6, 1, true);
    expect(inspectZip(bytes)).toEqual({ kind: "broken" });
  });

  it("finds the end record past a fake one in the comment", () => {
    const bytes = zipWith({
      comment: `PK\u0005\u0006${"c".repeat(40)}`,
      entries: [{ content: "a", name: "a.txt" }],
    });
    expect(inspectZip(bytes)).toMatchObject({ entries: 1, kind: "zip" });
  });

  it("tells a RAR from a ZIP", () => {
    const rar = Buffer.from("Rar!\u001a\u0007\u0001\u0000rest of it", "latin1");
    expect(inspectZip(new Uint8Array(rar))).toEqual({ kind: "not-zip" });
  });
});
