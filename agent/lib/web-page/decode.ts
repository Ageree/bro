/**
 * A page's text in its own encoding: many Russian sites still serve
 * windows-1251, named in the header or in a `<meta>` near the top.
 */
export function decodePage(bytes: Uint8Array, mediaType: string | undefined) {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString("latin1");
  const charset =
    /charset\s*=\s*["']?([\w-]+)/iu.exec(mediaType ?? "")?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/iu.exec(head)?.[1] ??
    /encoding=["']([\w-]+)["']/iu.exec(head)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
