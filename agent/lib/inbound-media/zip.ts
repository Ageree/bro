/**
 * A ZIP archive the person sends, judged by its central directory alone: no
 * entry is unpacked here (the task agent's kit does that, and caps the real
 * sizes). The declared sizes can lie, so they only bound what a bomb may
 * claim; an archive whose directory does not read as one is broken.
 */

const localFileHeader = 0x04034b50;
const endOfCentralDirectory = 0x06054b50;
const centralDirectoryHeader = 0x02014b50;
const zip64Locator = 0x07064b50;
const zip64EndOfCentralDirectory = 0x06064b50;
/** The ZIP64 extended information extra field. */
const zip64ExtraId = 0x0001;
/** A 32-bit size that stands for one the ZIP64 extra field carries. */
const zip64Marker = 0xffffffff;
/** The end record without its comment, and the longest comment it can have. */
const endRecordBytes = 22;
const maximumCommentBytes = 0xffff;
const centralHeaderBytes = 46;

/** More entries than the task agent should walk through. */
const maximumEntries = 1000;
/** What the entries may claim to unpack to, in all. */
const maximumUncompressedBytes = 256 * 1024 * 1024;

/** Where the end record lies: the one whose comment reaches the last byte. */
function endRecordAt(view: DataView) {
  const length = view.byteLength;
  const lowest = Math.max(0, length - endRecordBytes - maximumCommentBytes);
  for (let at = length - endRecordBytes; at >= lowest; at -= 1) {
    if (
      view.getUint32(at, true) === endOfCentralDirectory &&
      at + endRecordBytes + view.getUint16(at + 20, true) === length
    ) {
      return at;
    }
  }
  return undefined;
}

/** The directory's place and size, from the ZIP64 record when there is one. */
function directoryOf(view: DataView, end: number) {
  const locator = end - 20;
  if (locator >= 0 && view.getUint32(locator, true) === zip64Locator) {
    const record = Number(view.getBigUint64(locator + 8, true));
    if (view.getUint32(record, true) !== zip64EndOfCentralDirectory) {
      return undefined;
    }
    return {
      entries: Number(view.getBigUint64(record + 32, true)),
      offset: Number(view.getBigUint64(record + 48, true)),
      size: Number(view.getBigUint64(record + 40, true)),
    };
  }
  return {
    entries: view.getUint16(end + 10, true),
    offset: view.getUint32(end + 16, true),
    size: view.getUint32(end + 12, true),
  };
}

/** An entry's uncompressed size, from its ZIP64 extra field when it says so. */
function uncompressedSize(view: DataView, at: number, nameLength: number) {
  const size = view.getUint32(at + 24, true);
  if (size !== zip64Marker) return size;
  const extraLength = view.getUint16(at + 30, true);
  let field = at + centralHeaderBytes + nameLength;
  const end = field + extraLength;
  while (field + 4 <= end) {
    const id = view.getUint16(field, true);
    const length = view.getUint16(field + 2, true);
    // The uncompressed size comes first in the field when it is there.
    if (id === zip64ExtraId) return Number(view.getBigUint64(field + 4, true));
    field += 4 + length;
  }
  return undefined;
}

/**
 * What a file that claims to be a ZIP is: an archive with its entry count,
 * encrypted entries and declared uncompressed size; or not a ZIP at all, a
 * broken one, one with more than 1000 entries or one that claims more than
 * 256 MiB unpacked.
 */
export function inspectZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.byteLength < endRecordBytes ||
    (view.getUint32(0, true) !== localFileHeader &&
      view.getUint32(0, true) !== endOfCentralDirectory)
  ) {
    return { kind: "not-zip" } as const;
  }
  try {
    const end = endRecordAt(view);
    if (end === undefined) return { kind: "broken" } as const;
    const directory = directoryOf(view, end);
    if (directory === undefined) return { kind: "broken" } as const;
    if (directory.entries > maximumEntries) {
      return { kind: "too-many" } as const;
    }
    if (directory.offset + directory.size > bytes.byteLength) {
      return { kind: "broken" } as const;
    }
    let at = directory.offset;
    let encrypted = 0;
    let uncompressedBytes = 0;
    for (let entry = 0; entry < directory.entries; entry += 1) {
      if (view.getUint32(at, true) !== centralDirectoryHeader) {
        return { kind: "broken" } as const;
      }
      const nameLength = view.getUint16(at + 28, true);
      const size = uncompressedSize(view, at, nameLength);
      if (size === undefined) return { kind: "broken" } as const;
      uncompressedBytes += size;
      if (uncompressedBytes > maximumUncompressedBytes) {
        return { kind: "too-large" } as const;
      }
      // Bit 0 of the general purpose flags: the entry is encrypted.
      if ((view.getUint16(at + 8, true) & 1) === 1) encrypted += 1;
      at +=
        centralHeaderBytes +
        nameLength +
        view.getUint16(at + 30, true) +
        view.getUint16(at + 32, true);
    }
    return {
      encrypted,
      entries: directory.entries,
      kind: "zip",
      uncompressedBytes,
    } as const;
  } catch {
    // A field that points past the end: `DataView` throws a RangeError.
    return { kind: "broken" } as const;
  }
}
