import { deflateRawSync } from "node:zlib";

/**
 * A ZIP archive as `inspectZip` and `unpackZipEntries`
 * (`agent/lib/inbound-media/zip.ts`) read it: local entries stored as is or
 * deflated, a central directory and its end record. An entry may declare a
 * size other than its content's, as a bomb does, and `zip64` writes every
 * size and the directory's place the ZIP64 way.
 */
interface ZipEntry {
  readonly content?: string;
  /** The uncompressed size the directory claims, the content's by default. */
  readonly declaredSize?: number;
  readonly deflated?: boolean;
  readonly encrypted?: boolean;
  readonly name: string;
}

export function zipWith({
  comment = "",
  entries,
  zip64 = false,
}: {
  readonly comment?: string;
  readonly entries: readonly ZipEntry[];
  readonly zip64?: boolean;
}) {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const content = Buffer.from(entry.content ?? "");
    const flags = entry.encrypted === true ? 1 : 0;
    const method = entry.deflated === true ? 8 : 0;
    const packed = entry.deflated === true ? deflateRawSync(content) : content;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);

    const size = entry.declaredSize ?? content.length;
    const extra = Buffer.alloc(zip64 ? 20 : 0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
      extra.writeBigUInt64LE(BigInt(packed.length), 12);
    }
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(zip64 ? 0xffffffff : packed.length, 20);
    header.writeUInt32LE(zip64 ? 0xffffffff : size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    header.writeUInt32LE(offset, 42);
    directory.push(header, name, extra);
    offset += local.length + name.length + packed.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const records: Buffer[] = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directoryBytes.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directoryBytes.length), 8);
    locator.writeUInt32LE(1, 16);
    records.push(record, locator);
  }
  const commentBytes = Buffer.from(comment, "latin1");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directoryBytes.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  return new Uint8Array(
    Buffer.concat([...locals, directoryBytes, ...records, end, commentBytes])
  );
}
