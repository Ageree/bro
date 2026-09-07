import assert_ from "node:assert/strict";
import {
  fetchImagePart,
  IMAGE_TIMEOUT_MS,
  inboundImages,
  inboundUserContent,
  imageUrlParts,
  isImageContentType,
  isPlainJson,
} from "../agent/lib/inbound-image.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(isImageContentType("image/jpeg"), "jpeg");
assert(isImageContentType("IMAGE/PNG"), "case-insensitive");
assert(!isImageContentType("audio/x-caf"), "audio is not image");
assert(!isImageContentType(null), "null");

const media = [
  { url: "https://cdn.example/a.jpg", content_type: "image/jpeg; charset=binary", size: 1234 },
  { url: "https://cdn.example/v.caf", content_type: "audio/x-caf", size: 10 },
  { url: "   ", content_type: "image/png", size: 5 },
  { url: "https://cdn.example/b.heic", content_type: "image/heic", size: null },
];
const imgs = inboundImages(media);
assert(imgs.length === 2, "two images, audio and blank url skipped");
assert(imgs[0].mediaType === "image/jpeg", "params stripped from media type");
assert(imgs[1].size === null, "size null survives");
assert(inboundImages(null).length === 0, "null media");

const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const okFetch: typeof fetch = async () =>
  new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } });
const failFetch: typeof fetch = async () => new Response("nope", { status: 403 });
const throwFetch: typeof fetch = async () => {
  throw new Error("boom");
};

// small photo → data: base64 string (survives signed-URL expiry in session history)
const p1 = await fetchImagePart(imgs[0], { fetch: okFetch });
assert(p1.type === "file" && p1.mediaType === "image/jpeg", "file part");
assert(typeof p1.data === "string" && p1.data.startsWith("data:image/jpeg;base64,"), "data url string");
const decoded = Buffer.from(p1.data.slice(p1.data.indexOf(",") + 1), "base64");
assert(decoded.equals(Buffer.from(bytes)), "base64 decodes back to the same bytes");

// download problems → URL string part, never a dropped photo
const p2 = await fetchImagePart(imgs[0], { fetch: failFetch });
assert(p2.data === imgs[0].url, "403 falls back to url");
const p3 = await fetchImagePart(imgs[0], { fetch: throwFetch });
assert(p3.data === imgs[0].url, "throw falls back to url");
const p4 = await fetchImagePart({ ...imgs[0], size: 50 * 1024 * 1024 }, { fetch: okFetch });
assert(p4.data === imgs[0].url, "declared oversize (50 MiB) skips download");
const p4b = await fetchImagePart({ ...imgs[0], size: 4 * 1024 * 1024 }, { fetch: okFetch });
assert(p4b.data === imgs[0].url, "declared oversize (4 MiB, above the 3 MiB cap) skips download");
const p5 = await fetchImagePart(imgs[0], { fetch: okFetch, maxBytes: 3 });
assert(p5.data === imgs[0].url, "body over cap falls back to url");

// server content-type wins only when it is an image
const htmlFetch: typeof fetch = async () =>
  new Response(bytes, { status: 200, headers: { "content-type": "text/html" } });
const p6 = await fetchImagePart(imgs[0], { fetch: htmlFetch });
assert(p6.mediaType === "image/jpeg", "non-image response type ignored");

// channel payload: plain string without photos, text + parts with photos
const plain = await inboundUserContent("привет", [media[1]], { fetch: okFetch });
assert(plain === "привет", "no images → plain text");
const rich = await inboundUserContent("Найди мне эту книгу на озоне\nhttps://cdn.example/a.jpg", media, {
  fetch: okFetch,
});
assert(Array.isArray(rich) && rich.length === 3, "text + 2 image parts");
if (!Array.isArray(rich)) throw new Error("unreachable");
const [head, ...tail] = rich;
assert(head.type === "text" && head.text.startsWith("Найди"), "text first");
assert(tail.every((p) => p.type === "file"), "images after text");

// eve serialises turn.input into memory-tool closures with a strict JSON
// check — content must round-trip through JSON untouched (incident
// 2026-09-06: Uint8Array/URL broke this).
assert(isPlainJson(rich), "rich content is plain JSON");
assert_.deepEqual(JSON.parse(JSON.stringify(rich)), rich, "content round-trips through JSON");

// isPlainJson negative cases
assert(!isPlainJson(new Uint8Array(1)), "Uint8Array is not plain JSON");
assert(!isPlainJson(new URL("https://a.b")), "URL is not plain JSON");
assert(!isPlainJson(new Date()), "Date is not plain JSON");
assert(!isPlainJson(NaN), "NaN is not plain JSON");
assert(!isPlainJson(new Map()), "Map is not plain JSON");
assert(!isPlainJson(undefined), "undefined is not plain JSON");

// isPlainJson positive cases
assert(isPlainJson(null), "null is plain JSON");
assert(isPlainJson(42), "finite number is plain JSON");
assert(isPlainJson("hi"), "string is plain JSON");
assert(isPlainJson([1, "a", null, { b: [true, {}] }]), "nested plain arrays/objects are plain JSON");

assert(IMAGE_TIMEOUT_MS === 800, "inbound image wait is 800ms — URL fallback after");
const urls = imageUrlParts(media);
assert(urls.length === 2 && urls[0]?.data === imgs[0].url, "url parts skip the download");

console.log("inbound-image-check ok");
