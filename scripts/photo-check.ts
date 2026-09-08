import { readFileSync, existsSync } from "node:fs";
import {
  assertPublicPhotoUrl,
  extractMarkdownPhotoUrls,
  fetchPhotoBytes,
  imageMetaFromName,
  parseSendPhotoInput,
  photoFromBase64,
  photoFromBytes,
  PHOTO_MAX_BYTES,
  sniffImage,
  stripMarkdownPhotos,
} from "../agent/lib/outbound-photo.ts";
import { sendPhotoToHuman } from "../agent/lib/send-photo.ts";
import { deliverHuman } from "../agent/lib/deliver-human.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

assert(extractMarkdownPhotoUrls("нет фото").length === 0, "no photos");
assert(
  extractMarkdownPhotoUrls("смотри\n![книга](https://img.example/a.jpg)")[0] ===
    "https://img.example/a.jpg",
  "extract one photo",
);
assert(
  extractMarkdownPhotoUrls(
    "![a](https://a.example/1.png) x ![b](https://b.example/2.webp)",
  ).length === 2,
  "extract two photos",
);
assert(
  stripMarkdownPhotos("смотри\n![книга](https://img.example/a.jpg)") === "смотри",
  "strip photo leaves caption",
);

assert(sniffImage(JPEG) === "image/jpeg", "sniff jpeg");
assert(sniffImage(PNG) === "image/png", "sniff png");
assert(sniffImage(GIF) === "image/gif", "sniff gif");
assert(sniffImage(WEBP) === "image/webp", "sniff webp");
assert(sniffImage(Uint8Array.from([1, 2, 3])) === null, "sniff junk");

assert(imageMetaFromName("/home/user/screens/shot.png")?.contentType === "image/png", "png name");
assert(imageMetaFromName("desk.JPEG")?.contentType === "image/jpeg", "jpeg name");
assert(imageMetaFromName("note.txt") === null, "reject txt name");

assert(parseSendPhotoInput({}).error, "need path or url");
assert(parseSendPhotoInput({ path: "/a", url: "https://x.example/a.jpg" }).error, "not both");
assert(
  parseSendPhotoInput({ url: "http://x.example/a.jpg" }).error,
  "http rejected",
);
const parsedUrl = parseSendPhotoInput({ url: "https://img.example/a.jpg" });
assert(!("error" in parsedUrl) && parsedUrl.kind === "url", "https url ok");
const parsedPath = parseSendPhotoInput({ path: "/home/user/screens/shot.png" });
assert(!("error" in parsedPath) && parsedPath.kind === "path", "path ok");

try {
  assertPublicPhotoUrl("ftp://x.example/a.jpg");
  throw new Error("ftp should fail");
} catch (err) {
  assert(err instanceof Error && err.message.includes("https"), "ftp rejected");
}

const fromPng = photoFromBytes(PNG, "shot.png");
assert(fromPng.contentType === "image/png", "bytes png");
assert(fromPng.filename === "shot.png", "basename");
try {
  photoFromBytes(new Uint8Array(), "empty.png");
  throw new Error("empty should fail");
} catch (err) {
  assert(err instanceof Error && err.message.includes("пустой"), "empty rejected");
}
try {
  photoFromBytes(Uint8Array.from([1, 2, 3, 4]), "x.bin");
  throw new Error("bin should fail");
} catch (err) {
  assert(err instanceof Error && err.message.includes("не картинка"), "bin rejected");
}
const b64 = photoFromBase64(Buffer.from(JPEG).toString("base64"), "cam.jpg");
assert(b64.contentType === "image/jpeg", "base64 jpeg");

const fetched = await fetchPhotoBytes("https://img.example/desk.png", {
  fetch: async () =>
    new Response(PNG, {
      status: 200,
      headers: { "content-type": "image/png" },
    }),
});
assert(fetched.contentType === "image/png", "fetch png");
assert(fetched.filename === "desk.png", "fetch name from url");

let oversize = false;
try {
  await fetchPhotoBytes("https://img.example/huge.png", {
    maxBytes: 4,
    fetch: async () =>
      new Response(PNG, {
        status: 200,
        headers: { "content-length": String(PHOTO_MAX_BYTES + 1) },
      }),
  });
} catch {
  oversize = true;
}
assert(oversize, "oversize fetch rejected");

{
  const uploads: string[] = [];
  const media: string[][] = [];
  const sent = await sendPhotoToHuman({
    channel: "imessage",
    conversationId: "conv-1",
    handle: "bro-test",
    caption: "рабочий стол",
    source: { kind: "bytes", photo: fromPng },
    deps: {
      uploadIMessage: async (opts) => {
        uploads.push(opts.filename);
        return "https://inkbox.example/m.png";
      },
      sendIMessageMedia: async (opts) => {
        media.push(opts.mediaUrls);
        assert(opts.text === "рабочий стол", "imessage caption");
        assert(opts.conversationId === "conv-1", "imessage conversation");
        return { service: "imessage" } as never;
      },
    },
  });
  assert(sent.status === "ok" && sent.channel === "imessage", "imessage send ok");
  assert(uploads[0] === "shot.png", "uploaded filename");
  assert(media[0]?.[0] === "https://inkbox.example/m.png", "media url sent");
}

{
  const urls: string[] = [];
  const sent = await sendPhotoToHuman({
    channel: "telegram",
    telegramChatId: "42",
    caption: "книга",
    source: { kind: "url", url: "https://img.example/a.jpg" },
    deps: {
      sendTelegramUrl: async (opts) => {
        urls.push(String(opts.url));
        assert(opts.html === "книга", "telegram caption");
        return { message_id: 1 };
      },
    },
  });
  assert(sent.status === "ok" && sent.channel === "telegram", "telegram url ok");
  assert(urls[0] === "https://img.example/a.jpg", "telegram used url");
}

{
  const files: string[] = [];
  const sent = await sendPhotoToHuman({
    channel: "telegram",
    telegramChatId: "42",
    source: { kind: "bytes", photo: fromPng },
    deps: {
      sendTelegramFile: async (opts) => {
        files.push(opts.filename);
        assert(opts.contentType === "image/png", "telegram file type");
        return { message_id: 2 };
      },
    },
  });
  assert(sent.status === "ok", "telegram file ok");
  assert(files[0] === "shot.png", "telegram uploaded bytes");
}

{
  const missing = await sendPhotoToHuman({
    channel: "telegram",
    source: { kind: "url", url: "https://img.example/a.jpg" },
  });
  assert(missing.status === "error", "telegram needs chat id");
}

{
  const media: Array<{ urls: string[]; text?: string }> = [];
  const texts: string[] = [];
  await deliverHuman({
    tenant: { inkboxHandle: "bro-test" },
    conversationId: "conv-2",
    text: "вот стол\n![desk](https://img.example/desk.png)",
    channel: "imessage",
    deps: {
      fetchPhoto: async () => fromPng,
      uploadIMessage: async () => "https://inkbox.example/desk.png",
      sendIMessageMedia: async (opts) => {
        media.push({ urls: opts.mediaUrls, text: opts.text });
        return { service: "imessage" } as never;
      },
      sendIMessage: async (opts) => {
        texts.push(opts.text);
        return { service: "imessage" } as never;
      },
    },
  });
  assert(media.length === 1, "markdown photo attached on iMessage");
  assert(media[0]?.urls[0] === "https://inkbox.example/desk.png", "uploaded markdown photo");
  assert(media[0]?.text === "вот стол", "caption rides with photo");
  assert(texts.length === 0, "no leftover text bubble after photo");
}

{
  const texts: string[] = [];
  await deliverHuman({
    tenant: { inkboxHandle: "bro-test" },
    conversationId: "conv-3",
    text: "вот стол\n![desk](https://img.example/desk.png)",
    channel: "imessage",
    deps: {
      fetchPhoto: async () => {
        throw new Error("offline");
      },
      sendIMessage: async (opts) => {
        texts.push(opts.text);
        return { service: "imessage" } as never;
      },
    },
  });
  assert(texts.length === 1, "failed photo falls back to text");
  assert(texts[0]?.includes("https://img.example/desk.png"), "fallback keeps url");
}

{
  const photos: string[] = [];
  await deliverHuman({
    tenant: { telegramChatId: "99", lastChannel: "telegram" },
    text: "смотри\n![книга](https://img.example/a.jpg)",
    channel: "telegram",
    deps: {
      sendTelegramPhotoUrl: async (opts) => {
        photos.push(String(opts.url));
        return { message_id: 3 };
      },
    },
  });
  assert(photos[0] === "https://img.example/a.jpg", "telegram markdown still sendPhoto");
}

const tool = readFileSync(new URL("../agent/tools/send_photo.ts", import.meta.url), "utf8");
assert(tool.includes("sendPhotoToHuman"), "tool uses shared sender");
assert(tool.includes("parseSendPhotoInput"), "tool validates path/url");
assert(tool.includes("readBinaryFile"), "computer path reads the box file");
assert(tool.includes("asPersonal"), "computer path is personal-only");
assert(existsSync(new URL("../agent/tools/send_photo.ts", import.meta.url)), "tool mounted");

const shot = readFileSync(
  new URL("../agent/tools/computer_screenshot.ts", import.meta.url),
  "utf8",
);
assert(shot.includes("send_photo"), "screenshot tells the model to send the file");

const deliver = readFileSync(
  new URL("../agent/lib/deliver-human.ts", import.meta.url),
  "utf8",
);
assert(deliver.includes("extractMarkdownPhotoUrls"), "iMessage delivery sends markdown photos");
assert(deliver.includes("sendPhotoToHuman"), "iMessage photos share send_photo path");

const telegram = readFileSync(new URL("../agent/lib/telegram.ts", import.meta.url), "utf8");
assert(telegram.includes("sendTelegramPhotoFile"), "telegram can upload bytes");
assert(telegram.includes("apiForm"), "telegram photo file is multipart");
assert(!telegram.includes('"Content-Type": "application/json"') || telegram.includes("apiForm"), "json helper stays");

const inkbox = readFileSync(new URL("../agent/lib/inkbox.ts", import.meta.url), "utf8");
assert(inkbox.includes("uploadIMessagePhoto"), "inkbox uploads photo bytes");
assert(inkbox.includes("uploadIMessageMedia"), "inkbox uses identity media upload");

const instructions = readFileSync(
  new URL("../agent/instructions.md", import.meta.url),
  "utf8",
);
assert(instructions.includes("send_photo"), "instructions name the photo tool");
assert(instructions.includes("не могу вложить") === false || instructions.includes("Не пиши «не могу вложить»"), "do not claim you cannot attach");

const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
assert(pkg.includes("photo:check"), "npm script");

console.log("photo-check ok");
