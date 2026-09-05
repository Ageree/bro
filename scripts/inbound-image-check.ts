import {
  fetchImagePart,
  inboundImages,
  inboundUserContent,
  isImageContentType,
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

// small photo → bytes (survives signed-URL expiry in session history)
const p1 = await fetchImagePart(imgs[0], { fetch: okFetch });
assert(p1.type === "file" && p1.mediaType === "image/jpeg", "file part");
assert(p1.data instanceof Uint8Array && p1.data.byteLength === bytes.byteLength, "bytes kept");

// download problems → URL part, never a dropped photo
const p2 = await fetchImagePart(imgs[0], { fetch: failFetch });
assert(p2.data instanceof URL && p2.data.href === imgs[0].url, "403 falls back to url");
const p3 = await fetchImagePart(imgs[0], { fetch: throwFetch });
assert(p3.data instanceof URL, "throw falls back to url");
const p4 = await fetchImagePart({ ...imgs[0], size: 50 * 1024 * 1024 }, { fetch: okFetch });
assert(p4.data instanceof URL, "declared oversize skips download");
const p5 = await fetchImagePart(imgs[0], { fetch: okFetch, maxBytes: 3 });
assert(p5.data instanceof URL, "body over cap falls back to url");

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

console.log("inbound-image-check ok");
