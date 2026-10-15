/**
 * What a PDF's bytes say without parsing it (bro-eve never parses a PDF the
 * person sent): whether it is encrypted, and how many pages it has when its
 * page tree is in plain sight. Both are byte scans; checked against
 * `pdfinfo` on a hundred PDFs (scans, forms, LibreOffice, signed ones).
 */

/** `/Encrypt` naming the encryption dictionary in a trailer, not some text. */
const encryptReference = /^\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/u;
const pageType = /^\/Type\s*\/(Pages|Page)(?![A-Za-z])/u;
const pageCount = /\/Count\s+(\d{1,6})/u;
/** How far around a `/Type /Pages` its dictionary is looked for. */
const dictionaryWindow = 4096;
/**
 * Past this many hits a file is not worth scanning further: a page count
 * not yet found is unknown, and an encryption not yet ruled out is assumed.
 */
const maximumHits = 100_000;
/** A page tree of a few thousand pages has a few hundred inner nodes. */
const maximumPageTrees = 5000;

/** The `/Count` of the `/Type /Pages` dictionary at `at`, if it holds one. */
function countAround(buffer: Buffer, at: number) {
  const before = buffer.subarray(Math.max(0, at - dictionaryWindow), at);
  const open = before.lastIndexOf("<<");
  const start = open === -1 ? at - before.length : at - before.length + open;
  const after = buffer.subarray(at, at + dictionaryWindow);
  const close = after.indexOf(">>");
  const end = close === -1 ? at + after.length : at + close;
  const counted = pageCount.exec(buffer.toString("latin1", start, end))?.[1];
  return counted === undefined ? undefined : Number(counted);
}

/** Whether some `/Encrypt` names an encryption dictionary. */
function encryptedPdf(buffer: Buffer) {
  let hits = 0;
  for (
    let at = buffer.indexOf("/Encrypt");
    at !== -1;
    at = buffer.indexOf("/Encrypt", at + 8)
  ) {
    if (encryptReference.test(buffer.toString("latin1", at, at + 40))) {
      return true;
    }
    hits += 1;
    if (hits >= maximumHits) return true;
  }
  return false;
}

/**
 * The page count: the largest `/Count` of a `/Type /Pages` dictionary (the
 * root's), else the number of `/Type /Page` objects, else unknown (the page
 * tree inside compressed object streams).
 */
function pagesOf(buffer: Buffer) {
  let count: number | undefined;
  let pageObjects = 0;
  let pageTrees = 0;
  let hits = 0;
  for (
    let at = buffer.indexOf("/Type");
    at !== -1;
    at = buffer.indexOf("/Type", at + 5)
  ) {
    hits += 1;
    if (hits >= maximumHits) return count;
    const kind = pageType.exec(buffer.toString("latin1", at, at + 16))?.[1];
    if (kind === "Page") {
      pageObjects += 1;
    } else if (kind === "Pages" && pageTrees < maximumPageTrees) {
      pageTrees += 1;
      const counted = countAround(buffer, at);
      if (counted !== undefined) count = Math.max(count ?? 0, counted);
    }
  }
  return count ?? (pageObjects > 0 ? pageObjects : undefined);
}

export function pdfFacts(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { encrypted: encryptedPdf(buffer), pages: pagesOf(buffer) };
}
