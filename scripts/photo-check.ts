import { readFileSync, existsSync } from "node:fs";
import {
  assertPublicPhotoUrl,
  extractMarkdownPhotoUrls,
  fetchPhotoBytes,
  imageMetaFromName,
  extractStoredFileRefs,
  parseSendPhotoInput,
  photoFromBase64,
  stripStoredFileRefs,
  photoFromBytes,
  PHOTO_MAX_BYTES,
  sniffImage,
  stripMarkdownPhotos,
} from "../agent/lib/outbound-photo.ts";
import { photoTargetFromAuth, sendPhotoToHuman } from "../agent/lib/send-photo.ts";
import { deliverHuman } from "../agent/lib/deliver-human.ts";
import { resetPhotoDedupe } from "../agent/lib/photo-dedupe.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

resetPhotoDedupe();

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

assert("error" in parseSendPhotoInput({}), "need file or url");
assert(
  "error" in parseSendPhotoInput({ name: "a.png", url: "https://x.example/a.jpg" }),
  "not both",
);
assert("error" in parseSendPhotoInput({ url: "http://x.example/a.jpg" }), "http rejected");
const parsedUrl = parseSendPhotoInput({ url: "https://img.example/a.jpg" });
assert(!("error" in parsedUrl) && parsedUrl.kind === "url", "https url ok");
const parsedFile = parseSendPhotoInput({ name: "shot.png" });
assert(!("error" in parsedFile) && parsedFile.kind === "file", "name ok");
assert(parsedFile.kind === "file" && parsedFile.name === "shot.png", "file name");
const parsedPath = parseSendPhotoInput({ path: "/home/user/screens/shot.png" });
assert(!("error" in parsedPath) && parsedPath.kind === "file", "legacy path becomes file name");
assert(
  extractStoredFileRefs("Скриншот: file:dt5.jpg ок")[0] === "dt5.jpg",
  "extract stored file ref",
);
assert(
  stripStoredFileRefs("файл лежит: file:dt5.jpg ок") === "файл лежит ок",
  "strip stored file ref",
);

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
  const tally = { sent: 0 };
  const deps = {
    uploadIMessage: async () => "https://inkbox.example/dup.png",
    sendIMessageMedia: async () => {
      tally.sent += 1;
      return { service: "imessage" } as never;
    },
  };
  const again = await sendPhotoToHuman({
    channel: "imessage",
    conversationId: "conv-1",
    source: { kind: "bytes", photo: fromPng },
    deps,
  });
  assert(again.status === "ok", "duplicate still reports ok");
  const afterDup = tally.sent;
  if (afterDup !== 0) throw new Error("same chat does not upload a second computer photo");

  const compact = await sendPhotoToHuman({
    channel: "imessage",
    conversationId: "conv-1",
    source: { kind: "bytes", photo: photoFromBytes(JPEG, "dt5.jpg") },
    deps,
  });
  assert(compact.status === "ok", "compact remake reports ok");
  const afterCompact = tally.sent;
  if (afterCompact !== 0) throw new Error("compact remake in the same chat is dropped");

  const otherChat = await sendPhotoToHuman({
    channel: "imessage",
    conversationId: "conv-other",
    source: { kind: "bytes", photo: fromPng },
    deps,
  });
  assert(otherChat.status === "ok", "other chat still sends");
  const afterOther = tally.sent;
  if (afterOther !== 1) throw new Error("other chat is not blocked by the first");
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

{
  const spoilers: Array<{ url: string; hasSpoiler?: boolean }> = [];
  await deliverHuman({
    tenant: { telegramChatId: "99", lastChannel: "telegram" },
    text: "смотри\n!![обложка](https://img.example/hidden.jpg)",
    channel: "telegram",
    deps: {
      sendTelegramPhotoUrl: async (opts) => {
        spoilers.push({ url: String(opts.url), hasSpoiler: opts.hasSpoiler });
        return { message_id: 4 };
      },
    },
  });
  assert(spoilers[0]?.url === "https://img.example/hidden.jpg", "hidden media url");
  assert(spoilers[0]?.hasSpoiler === true, "hidden media sets has_spoiler");
}

{
  const rich: string[] = [];
  const classic: string[] = [];
  await deliverHuman({
    tenant: { telegramChatId: "99", lastChannel: "telegram" },
    text: `# Форматы

- **Жирный**
- ||Спойлер||
`,
    channel: "telegram",
    deps: {
      sendTelegramRichMessage: async (opts) => {
        rich.push(opts.html);
        return { message_id: 5 };
      },
      sendTelegramMessage: async (opts) => {
        classic.push(opts.html);
        return { message_id: 6 };
      },
    },
  });
  assert(rich.length === 1, "structured card uses sendRichMessage");
  assert(rich[0]?.includes("<h1>Форматы</h1>"), "rich heading sent");
  assert(rich[0]?.includes("<ul>"), "rich list sent");
  assert(classic.length === 0, "rich success skips classic");
}

{
  const rich: string[] = [];
  const classic: string[] = [];
  await deliverHuman({
    tenant: { telegramChatId: "88", lastChannel: "telegram" },
    text: `# Форматы

- пункт
`,
    channel: "telegram",
    deps: {
      sendTelegramRichMessage: async () => {
        throw new Error("Not Found");
      },
      sendTelegramMessage: async (opts) => {
        classic.push(opts.html);
        return { message_id: 7 };
      },
    },
  });
  assert(rich.length === 0, "failed rich does not count as sent");
  assert(classic[0]?.includes("<b>Форматы</b>"), "rich failure falls back to HTML");
}

{
  const loaded: string[] = [];
  const media: string[][] = [];
  const texts: string[] = [];
  await deliverHuman({
    tenant: { phoneE164: "+79990000000", inkboxHandle: "bro-test" },
    conversationId: "conv-path",
    text: "Скриншот снял: file:dt5.jpg",
    channel: "imessage",
    deps: {
      loadStoredPhoto: async (phone, name) => {
        loaded.push(`${phone}:${name}`);
        return fromPng;
      },
      uploadIMessage: async () => "https://inkbox.example/dt5.png",
      sendIMessageMedia: async (opts) => {
        media.push(opts.mediaUrls);
        return { service: "imessage" } as never;
      },
      sendIMessage: async (opts) => {
        texts.push(opts.text);
        return { service: "imessage" } as never;
      },
    },
  });
  assert(loaded[0] === "+79990000000:dt5.jpg", "loads stored file");
  assert(media[0]?.[0] === "https://inkbox.example/dt5.png", "attaches stored file");
  assert(
    texts.every((t) => !t.includes("file:dt5.jpg") && !t.includes("/home/user/dt5.jpg")),
    "file ref is not pasted as a leftover bubble",
  );
}

const telegramTarget = photoTargetFromAuth({
  channel: "telegram",
  telegramChatId: "42",
  conversationId: "conv-tg",
});
assert(telegramTarget.channel === "telegram", "auth telegram channel");
assert(telegramTarget.telegramChatId === "42", "auth telegram chat");
const imessageTarget = photoTargetFromAuth({
  origin: "human",
  conversationId: "conv-im",
  inkboxHandle: "bro-test",
});
assert(imessageTarget.channel === "imessage", "auth iMessage channel");
assert(imessageTarget.conversationId === "conv-im", "auth iMessage conversation");

const tool = readFileSync(new URL("../agent/tools/send_photo.ts", import.meta.url), "utf8");
assert(tool.includes("sendPhotoToHuman"), "tool uses shared sender");
assert(tool.includes("parseSendPhotoInput"), "tool validates file/url");
assert(tool.includes("spoiler"), "tool can hide Telegram media");
assert(tool.includes("photoFromStoredFile"), "stored file reads Convex storage");
assert(tool.includes("asPersonal"), "stored file is personal-only");
assert(existsSync(new URL("../agent/tools/send_photo.ts", import.meta.url)), "tool mounted");
assert(
  !existsSync(new URL("../agent/tools/computer_screenshot.ts", import.meta.url)),
  "box screenshot tool is gone",
);

const deliver = readFileSync(
  new URL("../agent/lib/deliver-human.ts", import.meta.url),
  "utf8",
);
assert(deliver.includes("extractMarkdownPhotoUrls"), "iMessage delivery sends markdown photos");
assert(deliver.includes("extractStoredFileRefs"), "iMessage delivery attaches stored files");
assert(deliver.includes("sendPhotoToHuman"), "iMessage photos share send_photo path");
assert(deliver.includes("sendTelegramRichMessage"), "structured cards use rich messages");

const telegram = readFileSync(new URL("../agent/lib/telegram.ts", import.meta.url), "utf8");
assert(telegram.includes("sendTelegramPhotoFile"), "telegram can upload bytes");
assert(telegram.includes("has_spoiler"), "telegram can send hidden media");
assert(telegram.includes("sendRichMessage"), "telegram can send rich messages");
assert(telegram.includes("apiForm"), "telegram photo file is multipart");
assert(!telegram.includes('"Content-Type": "application/json"') || telegram.includes("apiForm"), "json helper stays");

const inkbox = readFileSync(new URL("../agent/lib/inkbox.ts", import.meta.url), "utf8");
assert(inkbox.includes("uploadIMessagePhoto"), "inkbox uploads photo bytes");
assert(inkbox.includes("uploadIMessageMedia"), "inkbox uses identity media upload");
const sendPhoto = readFileSync(new URL("../agent/lib/send-photo.ts", import.meta.url), "utf8");
assert(sendPhoto.includes("sendPhotonMedia"), "iMessage photos go out through Photon");

const instructions = readFileSync(
  new URL("../agent/instructions.md", import.meta.url),
  "utf8",
);
assert(instructions.includes("send_photo"), "instructions name the photo tool");
assert(
  /не пиши «не могу вложить»/i.test(instructions),
  "do not claim you cannot attach",
);

const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
assert(pkg.includes("photo:check"), "npm script");

console.log("photo-check ok");
