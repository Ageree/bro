/**
 * The head of an office document's zip as `documentBytesMatch`
 * (`agent/lib/inbound-media/media-type.ts`) checks it: an OOXML package with
 * its `[Content_Types].xml` entry, or an OpenDocument one whose first,
 * uncompressed entry `mimetype` holds the document's media type.
 */
export function ooxmlPackage() {
  return localEntry("[Content_Types].xml", "<Types/>");
}

export function odfPackage(mediaType: string) {
  return localEntry("mimetype", mediaType);
}

/** A zip's local file header (stored, no extra field) and the entry's data. */
function localEntry(name: string, content: string) {
  const header = new Uint8Array(30);
  header.set([0x50, 0x4b, 0x03, 0x04]);
  header[26] = name.length;
  return Uint8Array.from([
    ...header,
    ...new TextEncoder().encode(name),
    ...new TextEncoder().encode(content),
  ]);
}
