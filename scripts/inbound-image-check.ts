import assert_ from "node:assert/strict";
import {
  assembleInboundContent,
  fetchImagePart,
  IMAGE_MAX_BYTES,
  IMAGE_TIMEOUT_MS,
  imageMediaTypeFromName,
  inboundImages,
  imageUrlParts,
  inlineImageParts,
  isImageContentType,
  MAX_INLINE_IMAGES,
  isPlainJson,
  PHOTO_ONLY_TEXT,
  PHOTO_UNREADABLE_TEXT,
  prefetchInboundImages,
} from "../agent/lib/inbound-image.ts";
import { photonInboundImages } from "../agent/lib/inbound-files.ts";
import { photoWithinBytes } from "../agent/lib/telegram.ts";

import { assert, src } from "./lib/check.ts";

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
const plain = assembleInboundContent("привет", await prefetchInboundImages([media[1]], { fetch: okFetch }));
assert(plain === "привет", "no images → plain text");
const rich = assembleInboundContent(
  "Найди мне эту книгу на озоне\nhttps://cdn.example/a.jpg",
  await prefetchInboundImages(media, { fetch: okFetch }),
);
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

assert(IMAGE_TIMEOUT_MS === 2_000, "inbound image wait is 2s — a photo is worth the second");
const urls = imageUrlParts(media);
assert(urls.length === 2 && urls[0]?.data === imgs[0].url, "url parts skip the download");

// A photo with no caption. An empty text part is not sent at all, and the
// channels put PHOTO_ONLY_TEXT in its place so the message is not empty to the
// gates on the way in.
const bare = assembleInboundContent("", await prefetchInboundImages([media[0]], { fetch: okFetch }));
assert(Array.isArray(bare) && bare.length === 1 && bare[0].type === "file", "no caption → image only");
assert(assembleInboundContent("   ", [{ type: "file", mediaType: "image/jpeg", data: "data:x" }]).length === 1, "blank caption is no caption");
assert(PHOTO_ONLY_TEXT.trim().length > 0 && PHOTO_UNREADABLE_TEXT.trim().length > 0, "markers are sayable");

// Media type from the filename: Photon attachments arrive as `{ url }` with no
// content type, and a photo with no declared type used to be dropped.
assert(imageMediaTypeFromName("photo.JPG") === "image/jpeg", "extension, any case");
assert(imageMediaTypeFromName("https://cdn.example/a/b.heic?sig=1") === "image/heic", "extension off a signed url");
assert(imageMediaTypeFromName("https://cdn.example/file") === undefined, "no extension, no guess");
assert(imageMediaTypeFromName("notes.pdf") === undefined, "pdf is not an image");
const untyped = inboundImages([
  { url: "https://cdn.example/a.png" },
  { url: "https://cdn.example/blob", content_type: "application/octet-stream", name: "IMG_0042.HEIC" },
  { url: "https://cdn.example/clip.caf", content_type: "audio/x-caf", name: "clip.jpg" },
  { url: "https://cdn.example/doc", content_type: "application/pdf" },
]);
assert(untyped.length === 2, "untyped image and octet-stream photo pass, audio and pdf do not");
assert(untyped[0].mediaType === "image/png" && untyped[1].mediaType === "image/heic", "guessed types");

// A part that is still a URL never made it past the download. On Telegram that
// URL is `…/bot<TOKEN>/…` — dropping it is the only safe move.
const inline = inlineImageParts([
  { type: "file", mediaType: "image/jpeg", data: "data:image/jpeg;base64,AA" },
  { type: "file", mediaType: "image/jpeg", data: "https://api.telegram.org/file/botSECRET/photo.jpg" },
]);
assert(inline.length === 1 && inline[0].data.startsWith("data:"), "url part dropped, inline kept");

// Photon inbound: both shapes of a photo the webhook can carry.
const captioned = photonInboundImages({
  message: {
    content: {
      type: "text",
      text: "найди мне эту книгу",
      attachments: [{ url: "https://cdn.photon/a.jpeg", size: 120 }],
    },
  },
});
assert(captioned.length === 1 && captioned[0].size === 120, "captioned photo is an attachment");
const bareFile = photonInboundImages({
  message: { content: { type: "file", url: "https://cdn.photon/b.png" } },
});
assert(bareFile.length === 1 && bareFile[0].mediaType === "image/png", "bare photo is a file content");
assert(photonInboundImages({ message: { content: { type: "text", text: "привет" } } }).length === 0, "plain text has no images");
assert(
  photonInboundImages({
    message: { content: { type: "text", text: "", attachments: [{ url: "https://cdn.photon/v.caf", mimeType: "audio/x-caf" }] } },
  }).length === 0,
  "voice attachment is not an image",
);

// An album does not get to blow up the turn input: the extra photos are still
// saved to the person's files, they just do not ride inline.
const album = photonInboundImages({
  message: {
    content: {
      type: "text",
      text: "вот квартира",
      attachments: Array.from({ length: 8 }, (_, i) => ({ url: `https://cdn.photon/${i}.jpg` })),
    },
  },
});
assert(album.length === MAX_INLINE_IMAGES, "album is capped at MAX_INLINE_IMAGES");

// Telegram sends several renditions; the cap must pick one that fits instead
// of refusing the biggest and sending nothing.
const sizes = {
  chat: { id: 1, type: "private" as const },
  message_id: 1,
  photo: [
    { file_id: "s", file_size: 20_000 },
    { file_id: "m", file_size: 200_000 },
    { file_id: "l", file_size: 9_000_000 },
  ],
};
assert(photoWithinBytes(sizes, IMAGE_MAX_BYTES)?.file_id === "m", "largest rendition under the cap");
assert(photoWithinBytes({ ...sizes, photo: [{ file_id: "huge", file_size: 9_000_000 }] }, IMAGE_MAX_BYTES)?.file_id === "huge", "only an oversize one left → try it");
assert(photoWithinBytes({ ...sizes, photo: [] }, IMAGE_MAX_BYTES) === undefined, "no photo");

// The pipeline above is only worth anything if a channel calls it. It was
// wired, tested, and documented for months while `/webhooks/photon` passed an
// empty parts list — every photo on the main channel answered from the caption
// alone.
const imessage = src("agent/channels/imessage.ts");
assert(imessage.includes("photonInboundImages(parsed)"), "photon inbound reads its attachments");
assert(
  imessage.includes("assembleInboundContent(inbound.text, photoParts)"),
  "the photon turn carries the photo, not just the caption",
);
assert(!imessage.includes("assembleInboundContent(inbound.text, [])"), "no empty parts list");
const telegram = src("agent/channels/telegram.ts");
assert(telegram.includes("inlineImageParts"), "telegram keeps the tokened file url away from the model");
assert(telegram.includes("photoWithinBytes"), "telegram picks a rendition that fits the cap");

console.log("inbound-image-check ok");
