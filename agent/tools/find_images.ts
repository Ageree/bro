/**
 * Finds the real photos on a web page so `send_message` can deliver them as
 * attachments. `web_fetch` Markdown keeps `![alt](src)`, but on a real listing
 * that is mostly icons, sprites, lazy-load placeholders and relative paths,
 * and the `og:image` in `<head>` never reaches the Markdown at all. This tool
 * reads the markup directly, drops the obvious junk, and keeps only candidates
 * that answer as a downloadable image of a known size.
 *
 * Nothing here logs a URL: a listing link can carry a personal token.
 */

import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import {
  baseMediaType,
  isImageMediaType,
  sniffMediaType,
} from "@agent/lib/inbound-media/media-type";
import {
  isBlockedHost,
  maximumAttachmentBytes,
} from "@agent/lib/outbound-media/attachments";

const pageTimeoutMs = 15_000;
const probeTimeoutMs = 8_000;
/** Listing pages run to a couple of megabytes; the gallery sits well inside. */
const pageByteCap = 4 * 1024 * 1024;
/** Enough of an image for its signature and, usually, its dimensions. */
const probeByteCount = 4096;
const maximumRedirects = 5;
const maximumProbes = 20;
const defaultLimit = 6;
/** A side shorter than this is an icon, a thumbnail or a spacer, not a photo. */
const minimumSide = 200;
/** Smaller files are tracking pixels and placeholders even without dimensions. */
const minimumImageBytes = 5000;

/**
 * Sent with the page request only. Image probes go out with fetch's defaults,
 * exactly as `send_message` will download them, so a candidate that only a
 * browser could fetch is dropped here rather than failing at delivery.
 */
const pageHeaders = {
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
};

const redirectStatuses: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/** Statuses an anti-bot wall answers with even when the body says nothing. */
const refusalStatuses: ReadonlySet<number> = new Set([403, 429]);

/**
 * Markup that a challenge page carries. A real article can mention the same
 * words in its scripts, so markers only count on a page as small as a
 * challenge page is.
 */
const challengeMarkers =
  /challenge-platform|cf-chl-|cf_chl_|ddos-guard|_incapsula_resource|px-captcha|__qrator|showcaptcha|captcha-delivery\.com/iu;
const challengePageBytes = 200_000;
const challengeTitles =
  /just a moment|attention required|access denied|доступ ограничен|доступ запрещ|вы не робот|are you a robot|подтвердите, что вы человек|captcha/iu;

/** Where sites send a client they want to check, such as `/showcaptcha`. */
const challengePath = /captcha|challenge/iu;

/** Paths that name page furniture rather than content. */
const furniturePath = /icon|logo|sprite|avatar|badge|favicon/u;
const pixelPath = /(?:^|[/_.-])(?:pixel|spacer|blank|1x1)(?:[/_.-]|$)/u;
const trackingHosts = [
  "counter.yadro.ru",
  "doubleclick.net",
  "facebook.com",
  "google-analytics.com",
  "googletagmanager.com",
  "mc.yandex.com",
  "mc.yandex.ru",
  "scorecardresearch.com",
  "tns-counter.ru",
  "top-fwz1.mail.ru",
  "vk.com",
];

const featuredImageProperties: ReadonlySet<string> = new Set([
  "og:image",
  "og:image:secure_url",
  "og:image:url",
]);
const socialImageProperties: ReadonlySet<string> = new Set([
  "twitter:image",
  "twitter:image:src",
]);
const linkedDataImageKeys: ReadonlySet<string> = new Set([
  "image",
  "images",
  "photo",
  "photos",
]);

const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;
const stylePattern = /<style\b[^>]*>[\s\S]*?<\/style\s*>/giu;
const tagPattern = /<(\/?)(img|source|meta|link|picture|base)\b([^>]*)>/giu;
const attributePattern =
  /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/gu;
/** Absolute image URLs inside inline state, such as a gallery's JSON. */
const embeddedImagePattern =
  /https?:\/\/[^\s"'<>\\()]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'<>\\()]*)?(?=["'\s\\)<,]|$)/giu;
const maximumEmbeddedImages = 200;

const namedEntities: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["lt", "<"],
  ["nbsp", " "],
  ["quot", '"'],
]);

const jsonValueSchema = z.json();
type JsonValue = z.infer<typeof jsonValueSchema>;
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
const imageObjectSchema = z.object({
  contentUrl: z.string().optional(),
  url: z.string().optional(),
});

/** One place on the page that may name a photo, before it is checked. */
interface ImageCandidate {
  readonly url: string;
  /** The page's own `og:image`, which the ranking puts first. */
  readonly featured: boolean;
  alt?: string;
  height?: number;
  width?: number;
}

const inputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "How many images to return, best first. Default 6; one Telegram album holds up to 10."
    ),
  url: z
    .url()
    .refine((url) => URL.parse(url)?.protocol === "https:", {
      message: "The page must use HTTPS.",
    })
    .describe(
      "The page to take photos from: a listing, product card, article or place page."
    ),
});

export const findImages = defineTool({
  description:
    "Find the real photos on a web page so they can be sent with send_message attachments. Give it the page URL, such as a flat or car listing, a product card, an article or a place. It reads og:image, img src, srcset and lazy-load attributes, picture sources, JSON-LD and inline gallery data, drops icons, logos, sprites, avatars and tracking pixels, and keeps only candidates that download as an image of a known size. Returns direct HTTPS image URLs best first, with media type, byte size, dimensions and alt text when known; put the best of them in send_message attachments with kind image. When the page sits behind an anti-bot check the call fails with a message saying so: tell the person plainly that the site blocked automated access rather than implying the page has no photos.",
  inputSchema,
  label: {
    start: ({ url }) => `Ищу фото на ${URL.parse(url)?.hostname ?? "странице"}`,
  },
  async execute(input) {
    const limit = input.limit ?? defaultLimit;
    const page = await loadPage(new URL(input.url));
    const candidates =
      page.kind === "image"
        ? [{ featured: true, url: page.url.href }]
        : scanPage(page.html).candidates;
    const pageTitle = page.kind === "html" ? scanTitle(page.html) : undefined;
    const base =
      page.kind === "html" ? pageBase(page.html, page.url) : page.url;

    const probes = await Promise.all(
      usableCandidates(candidates, base)
        .slice(0, maximumProbes)
        .map(async (candidate, order) => probeImage(candidate, order))
    );
    const images = distinctImages(
      probes
        .filter((image) => image !== undefined)
        .toSorted(
          (left, right) =>
            Number(right.featured) - Number(left.featured) ||
            right.bytes - left.bytes ||
            left.order - right.order
        )
    )
      .slice(0, limit)
      .map((image) => ({
        alt: image.alt,
        bytes: image.bytes,
        height: image.height,
        mimeType: image.mimeType,
        url: image.url,
        width: image.width,
      }));

    return {
      images,
      notice:
        images.length === 0
          ? "No downloadable photos were found in the page markup. The gallery may load with JavaScript after the page opens; a browser task can collect the image links instead."
          : undefined,
      pageTitle,
    };
  },
});

async function loadPage(url: URL) {
  const signal = AbortSignal.timeout(pageTimeoutMs);
  const loaded = await fetchFollowingRedirects(
    url,
    { headers: pageHeaders, signal },
    maximumRedirects
  );
  if ("failure" in loaded) throw new Error(pageFailureMessage(loaded.failure));
  const { response } = loaded;
  let prefix: Awaited<ReturnType<typeof readPrefix>>;
  try {
    prefix = await readPrefix(response, pageByteCap);
  } catch {
    throw new Error(pageFailureMessage("network"));
  }
  const contentType = response.headers.get("content-type");
  if (!response.ok) {
    const html = decodeHtml(prefix.bytes, contentType);
    if (refusalStatuses.has(response.status) || isChallengePage(html)) {
      throw new Error(antiBotMessage(`HTTP ${String(response.status)}`));
    }
    throw new Error(
      `The page answered HTTP ${String(response.status)}, so its photos could not be read.`
    );
  }
  const mediaType =
    sniffMediaType(prefix.bytes) ?? baseMediaType(contentType) ?? "";
  if (isImageMediaType(mediaType)) {
    return { kind: "image" as const, url: loaded.url };
  }
  const html = decodeHtml(prefix.bytes, contentType);
  if (isChallengePage(html)) throw new Error(antiBotMessage("a check page"));
  return { html, kind: "html" as const, url: loaded.url };
}

function pageFailureMessage(failure: FetchFailure) {
  switch (failure) {
    case "challenge":
      return antiBotMessage("a redirect to a captcha page");
    case "blocked-host":
      return "The page or one of its redirects points at a local or private address (a blocked host), so it was not fetched.";
    case "not-https":
      return "The page redirected to a non-HTTPS address, so it was not fetched.";
    case "timeout":
      return "The page did not answer in time.";
    case "too-many-redirects":
      return "The page redirected too many times.";
    case "network":
      return "The page could not be reached.";
    default:
      return "The page could not be fetched.";
  }
}

function antiBotMessage(evidence: string) {
  return `The site answered with an anti-bot check (${evidence}) instead of the page, so its photos cannot be read from here. Tell the person plainly that the site blocked automated access; do not say the page has no photos. A browser task can still open the page if they want.`;
}

function isChallengePage(html: string) {
  if (html.length < challengePageBytes && challengeMarkers.test(html)) {
    return true;
  }
  const title = scanTitle(html);
  return title !== undefined && challengeTitles.test(title);
}

type FetchFailure =
  | "blocked-host"
  | "challenge"
  | "network"
  | "not-https"
  | "timeout"
  | "too-many-redirects";

/**
 * Follows redirects by hand so every hop is checked: fetch's own redirect
 * handling would reach a private or plain-HTTP address before the caller saw
 * where it was going.
 */
async function fetchFollowingRedirects(
  url: URL,
  init: RequestInit,
  redirectsLeft: number
): Promise<
  | { readonly response: Response; readonly url: URL }
  | { readonly failure: FetchFailure }
> {
  if (url.protocol !== "https:") return { failure: "not-https" };
  if (isBlockedHost(url.hostname)) return { failure: "blocked-host" };
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "manual" });
  } catch (error) {
    return {
      failure:
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "network",
    };
  }
  const location = redirectStatuses.has(response.status)
    ? response.headers.get("location")
    : null;
  if (location === null) return { response, url };
  await response.body?.cancel().catch(() => undefined);
  if (redirectsLeft === 0) return { failure: "too-many-redirects" };
  const next = URL.parse(location, url);
  if (!next) return { failure: "network" };
  if (challengePath.test(next.pathname)) return { failure: "challenge" };
  return fetchFollowingRedirects(next, init, redirectsLeft - 1);
}

/**
 * Reads at most `limit` bytes and cancels the rest. `complete` says whether
 * the body ended within the limit, which makes its length the file size.
 */
async function readPrefix(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), complete: true };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- The body arrives as a sequence of chunks.
    const { done, value } = await reader.read();
    if (done) {
      complete = true;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
    if (total >= limit) break;
  }
  if (!complete) await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.byteLength - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, complete };
}

function decodeHtml(bytes: Uint8Array, contentType: string | null) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const charset =
    /charset\s*=\s*["']?([\w-]+)/iu.exec(contentType ?? "")?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/iu.exec(head)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function scanTitle(html: string) {
  const ogTitle = [...html.matchAll(tagPattern)]
    .map((match) => parseAttributes(match[3] ?? ""))
    .find((attributes) => attributes.get("property") === "og:title")
    ?.get("content");
  const title =
    ogTitle ?? /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(html)?.[1];
  const clean = title
    ? decodeEntities(title).replaceAll(/\s+/gu, " ").trim().slice(0, 300)
    : "";
  return clean.length > 0 ? clean : undefined;
}

/** The URL relative paths resolve against: `<base href>` when the page has one. */
function pageBase(html: string, pageUrl: URL) {
  const tag = [...html.matchAll(tagPattern)].find(
    (match) => match[2]?.toLowerCase() === "base"
  );
  const href = tag ? parseAttributes(tag[3] ?? "").get("href") : undefined;
  return (href ? URL.parse(href, pageUrl) : null) ?? pageUrl;
}

/**
 * Every place the page names an image, best sources first: `og:image`, the
 * other social and `image_src` tags, `<img>` and `<picture>` in document
 * order, JSON-LD, and finally image URLs found in inline scripts.
 */
function scanPage(html: string) {
  const text = html.replaceAll(/<!--[\s\S]*?-->/gu, " ");
  const linkedData: string[] = [];
  const scripts: string[] = [];
  for (const match of text.matchAll(scriptPattern)) {
    const type = parseAttributes(match[1] ?? "").get("type") ?? "";
    (type.toLowerCase().includes("ld+json") ? linkedData : scripts).push(
      match[2] ?? ""
    );
  }
  const markup = text
    .replaceAll(scriptPattern, " ")
    .replaceAll(stylePattern, " ");

  const featured: ImageCandidate[] = [];
  const social: ImageCandidate[] = [];
  const inline: ImageCandidate[] = [];
  let picture: { fallback?: ImageCandidate; resolved: boolean } | undefined;

  for (const match of markup.matchAll(tagPattern)) {
    const closing = match[1] === "/";
    const tag = match[2]?.toLowerCase();
    const attributes = parseAttributes(match[3] ?? "");
    if (tag === "picture") {
      if (closing && picture && !picture.resolved && picture.fallback) {
        inline.push(picture.fallback);
      }
      picture = closing ? undefined : { resolved: false };
    } else if (tag === "img") {
      const candidate = imgCandidate(attributes);
      if (candidate) inline.push(candidate);
      if (picture && candidate) picture.resolved = true;
    } else if (tag === "source") {
      // A <source> outside <picture> belongs to a video or an audio file.
      if (picture && !picture.fallback) {
        picture.fallback = sourceCandidate(attributes);
      }
    } else if (tag === "meta") {
      readMeta(attributes, featured, social);
    } else if (tag === "link") {
      const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/u);
      const href = attributes.get("href");
      if (rel.includes("image_src") && href) {
        social.push({ featured: false, url: href });
      }
    }
  }

  const structuredImages = linkedData.flatMap((source) =>
    readLinkedDataImages(source)
  );
  const embedded = scripts
    .flatMap((source) => embeddedImageUrls(source))
    .slice(0, maximumEmbeddedImages);
  return {
    candidates: [
      ...featured,
      ...social,
      ...inline,
      ...[...structuredImages, ...embedded].map((url) => ({
        featured: false,
        url,
      })),
    ],
  };
}

function readMeta(
  attributes: ReadonlyMap<string, string>,
  featured: ImageCandidate[],
  social: ImageCandidate[]
) {
  const property = (
    attributes.get("property") ??
    attributes.get("name") ??
    ""
  ).toLowerCase();
  const content = attributes.get("content");
  if (!content) return;
  const latest = featured.at(-1);
  if (featuredImageProperties.has(property)) {
    featured.push({ featured: true, url: content });
  } else if (socialImageProperties.has(property)) {
    social.push({ featured: false, url: content });
  } else if (latest && property === "og:image:width") {
    latest.width = positiveInteger(content);
  } else if (latest && property === "og:image:height") {
    latest.height = positiveInteger(content);
  } else if (latest && property === "og:image:alt") {
    latest.alt = content;
  }
}

/**
 * The best URL an `<img>` offers. A lazy-loading page keeps a placeholder in
 * `src` and the photo in `data-src` or a `srcset`, so the largest `srcset`
 * entry wins, then the lazy attributes, then `src`.
 */
function imgCandidate(
  attributes: ReadonlyMap<string, string>
): ImageCandidate | undefined {
  const url = [
    largestSrcsetUrl(attributes.get("srcset")),
    largestSrcsetUrl(attributes.get("data-srcset")),
    attributes.get("data-src"),
    attributes.get("data-lazy-src"),
    attributes.get("data-original"),
    attributes.get("src"),
  ].find((value) => value !== undefined && !isDataUri(value));
  if (!url) return undefined;
  const alt = attributes.get("alt")?.trim();
  return {
    alt: alt && alt.length > 0 ? alt : undefined,
    featured: false,
    height: positiveInteger(attributes.get("height")),
    url,
    width: positiveInteger(attributes.get("width")),
  };
}

/** Telegram shows these as photos; an AVIF or JXL source would arrive as a file. */
const photoSourceTypes: ReadonlySet<string> = new Set([
  "",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function sourceCandidate(
  attributes: ReadonlyMap<string, string>
): ImageCandidate | undefined {
  const type = baseMediaType(attributes.get("type")) ?? "";
  if (!photoSourceTypes.has(type)) return undefined;
  const url =
    largestSrcsetUrl(attributes.get("srcset")) ??
    largestSrcsetUrl(attributes.get("data-srcset"));
  return url && !isDataUri(url) ? { featured: false, url } : undefined;
}

/**
 * Parses a `srcset` the way a browser splits it: a URL runs to the next
 * whitespace and may itself contain commas, and its descriptor runs to the
 * next comma. Width descriptors rank by width; density descriptors rank a
 * `2x` above a plain entry.
 */
function largestSrcsetUrl(srcset: string | undefined) {
  if (!srcset) return undefined;
  let best: { score: number; url: string } | undefined;
  let rest = srcset.trim();
  while (rest.length > 0) {
    const raw = /^\S+/u.exec(rest)?.[0] ?? "";
    rest = rest.slice(raw.length);
    let url = raw;
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/u, "");
    } else {
      const comma = rest.indexOf(",");
      descriptor = (comma === -1 ? rest : rest.slice(0, comma)).trim();
      rest = comma === -1 ? "" : rest.slice(comma + 1);
    }
    rest = rest.trimStart();
    const score = srcsetScore(descriptor);
    if (url.length > 0 && (!best || score > best.score)) best = { score, url };
  }
  return best?.url;
}

function srcsetScore(descriptor: string) {
  const match = /^([\d.]+)([wx])$/iu.exec(descriptor);
  const value = Number(match?.[1]);
  if (!match || !Number.isFinite(value)) return 1000;
  return match[2]?.toLowerCase() === "w" ? value : value * 1000;
}

function readLinkedDataImages(source: string) {
  try {
    const parsed = jsonValueSchema.safeParse(JSON.parse(source));
    return parsed.success ? linkedDataImages(parsed.data, 0) : [];
  } catch {
    return [];
  }
}

function linkedDataImages(value: JsonValue, depth: number): string[] {
  if (depth > 6 || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => linkedDataImages(item, depth + 1));
  }
  const object = jsonObjectSchema.safeParse(value);
  if (!object.success) return [];
  return Object.entries(object.data).flatMap(([key, child]) =>
    linkedDataImageKeys.has(key)
      ? imageReferences(child)
      : linkedDataImages(child, depth + 1)
  );
}

/** A schema.org `image`: a URL, an `ImageObject`, or a list of either. */
function imageReferences(value: JsonValue): string[] {
  const text = z.string().safeParse(value);
  if (text.success) return [text.data];
  if (Array.isArray(value)) return value.flatMap(imageReferences);
  const object = imageObjectSchema.safeParse(value);
  const url = object.success
    ? (object.data.contentUrl ?? object.data.url)
    : undefined;
  return url ? [url] : [];
}

function embeddedImageUrls(source: string) {
  const unescaped = source.replaceAll("\\/", "/").replaceAll(/\\u002f/giu, "/");
  return [...unescaped.matchAll(embeddedImagePattern)].map((match) => match[0]);
}

/**
 * Resolves every candidate against the page, drops the junk, and keeps the
 * first mention of each URL.
 */
function usableCandidates(
  candidates: readonly ImageCandidate[],
  base: URL
): (ImageCandidate & { readonly href: string })[] {
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const url = resolveImageUrl(candidate.url, base);
    if (!url || seen.has(url.href) || isJunk(url, candidate)) return [];
    seen.add(url.href);
    return [{ ...candidate, href: url.href }];
  });
}

function resolveImageUrl(raw: string, base: URL) {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || isDataUri(trimmed)) return undefined;
  const url = URL.parse(trimmed, base);
  if (!url) return undefined;
  // Most image CDNs serve both; attachments must be HTTPS, and the probe
  // proves the upgraded address answers.
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") return undefined;
  url.hash = "";
  return url;
}

function isJunk(url: URL, candidate: ImageCandidate) {
  if (isBlockedHost(url.hostname)) return true;
  const host = url.hostname.toLowerCase();
  if (
    trackingHosts.some(
      (tracker) => host === tracker || host.endsWith(`.${tracker}`)
    )
  ) {
    return true;
  }
  const path = decodedPath(url).toLowerCase();
  if (/\.(?:svg|ico)$/u.test(path)) return true;
  if (furniturePath.test(path) || pixelPath.test(path)) return true;
  return isSmall(candidate.width) || isSmall(candidate.height);
}

function decodedPath(url: URL) {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

function isSmall(side: number | undefined) {
  return side !== undefined && side < minimumSide;
}

function isDataUri(value: string) {
  return /^\s*data:/iu.test(value);
}

/**
 * Asks for the first bytes of a candidate the way `send_message` will fetch
 * it, and keeps it only when the bytes are an image of a known, deliverable
 * size.
 */
async function probeImage(
  candidate: ImageCandidate & { readonly href: string },
  order: number
) {
  const fetched = await fetchFollowingRedirects(
    new URL(candidate.href),
    {
      headers: { range: `bytes=0-${String(probeByteCount - 1)}` },
      signal: AbortSignal.timeout(probeTimeoutMs),
    },
    maximumRedirects
  );
  if ("failure" in fetched) return undefined;
  const { response } = fetched;
  if (response.status !== 200 && response.status !== 206) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  let prefix: Awaited<ReturnType<typeof readPrefix>>;
  try {
    prefix = await readPrefix(response, probeByteCount);
  } catch {
    return undefined;
  }
  const mimeType =
    sniffMediaType(prefix.bytes) ??
    baseMediaType(response.headers.get("content-type"));
  if (!isImageMediaType(mimeType) || mimeType === "image/svg+xml") {
    return undefined;
  }
  const bytes = fileSize(response, prefix);
  if (
    bytes === undefined ||
    bytes < minimumImageBytes ||
    bytes > maximumAttachmentBytes
  ) {
    return undefined;
  }
  const measured = imageDimensions(prefix.bytes);
  const width = measured?.width ?? candidate.width;
  const height = measured?.height ?? candidate.height;
  if (isSmall(width) || isSmall(height)) return undefined;
  return {
    alt: candidate.alt,
    bytes,
    featured: candidate.featured,
    height,
    mimeType,
    order,
    url: candidate.href,
    width,
  };
}

function fileSize(
  response: Response,
  prefix: { readonly bytes: Uint8Array; readonly complete: boolean }
) {
  if (response.status === 206) {
    const total = /\/(\d+)\s*$/u.exec(
      response.headers.get("content-range") ?? ""
    )?.[1];
    return positiveInteger(total);
  }
  return (
    positiveInteger(response.headers.get("content-length")) ??
    (prefix.complete ? prefix.bytes.byteLength : undefined)
  );
}

/** The same photo served under two URLs arrives with the same bytes. */
function distinctImages<
  T extends {
    readonly bytes: number;
    readonly height?: number;
    readonly mimeType: string;
    readonly width?: number;
  },
>(images: readonly T[]) {
  const seen = new Set<string>();
  return images.filter((image) => {
    const key = [
      image.mimeType,
      String(image.bytes),
      String(image.width),
      String(image.height),
    ].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function byteAt(bytes: Uint8Array, index: number) {
  return bytes[index] ?? 0;
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/**
 * Pixel dimensions from the first bytes of a JPEG, PNG, GIF or WebP. A JPEG
 * whose frame header sits past the probed bytes, behind a large EXIF block,
 * has no answer here.
 */
function imageDimensions(bytes: Uint8Array) {
  const type = sniffMediaType(bytes);
  if (type === "image/png" && bytes.length >= 24) {
    return {
      height: readUint32(bytes, 20),
      width: readUint32(bytes, 16),
    };
  }
  if (type === "image/gif" && bytes.length >= 10) {
    return {
      height: byteAt(bytes, 8) | (byteAt(bytes, 9) << 8),
      width: byteAt(bytes, 6) | (byteAt(bytes, 7) << 8),
    };
  }
  if (type === "image/webp") return webpDimensions(bytes);
  if (type === "image/jpeg") return jpegDimensions(bytes);
  return undefined;
}

function readUint32(bytes: Uint8Array, offset: number) {
  return (
    byteAt(bytes, offset) * 0x1000000 +
    ((byteAt(bytes, offset + 1) << 16) |
      (byteAt(bytes, offset + 2) << 8) |
      byteAt(bytes, offset + 3))
  );
}

function webpDimensions(bytes: Uint8Array) {
  if (bytes.length < 30) return undefined;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") {
    return {
      height: (byteAt(bytes, 28) | (byteAt(bytes, 29) << 8)) & 0x3fff,
      width: (byteAt(bytes, 26) | (byteAt(bytes, 27) << 8)) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    const b1 = byteAt(bytes, 21);
    const b2 = byteAt(bytes, 22);
    const b3 = byteAt(bytes, 23);
    const b4 = byteAt(bytes, 24);
    return {
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
      width: 1 + (((b2 & 0x3f) << 8) | b1),
    };
  }
  if (chunk === "VP8X") {
    return {
      height:
        1 +
        (byteAt(bytes, 27) |
          (byteAt(bytes, 28) << 8) |
          (byteAt(bytes, 29) << 16)),
      width:
        1 +
        (byteAt(bytes, 24) |
          (byteAt(bytes, 25) << 8) |
          (byteAt(bytes, 26) << 16)),
    };
  }
  return undefined;
}

/** Start-of-frame markers; 0xC4, 0xC8 and 0xCC share the range but are not frames. */
function isStartOfFrame(marker: number) {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function jpegDimensions(bytes: Uint8Array) {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (byteAt(bytes, offset) !== 0xff) return undefined;
    const marker = byteAt(bytes, offset + 1);
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (isStartOfFrame(marker)) {
      return {
        height: (byteAt(bytes, offset + 5) << 8) | byteAt(bytes, offset + 6),
        width: (byteAt(bytes, offset + 7) << 8) | byteAt(bytes, offset + 8),
      };
    }
    offset +=
      2 + ((byteAt(bytes, offset + 2) << 8) | byteAt(bytes, offset + 3));
  }
  return undefined;
}

function parseAttributes(source: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(attributePattern)) {
    const name = match[1]?.toLowerCase();
    if (!name || attributes.has(name)) continue;
    attributes.set(
      name,
      decodeEntities(match[2] ?? match[3] ?? match[4] ?? "")
    );
  }
  return attributes;
}

function decodeEntities(value: string) {
  return value.replaceAll(
    /&(#x[\da-f]+|#\d+|[a-z]+);/giu,
    (entity, name: string) => {
      const lower = name.toLowerCase();
      if (!lower.startsWith("#")) return namedEntities.get(lower) ?? entity;
      const code = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
  );
}

function positiveInteger(value: string | null | undefined) {
  if (!value || !/^\s*\d+\s*$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export default defineDynamic({
  events: {
    // Fetching an arbitrary page is out of reach of Bro's own mail checks and
    // of report turns, which only deliver what a worker handed over.
    "turn.started": (_event, context) =>
      resolveModeValue(context, {
        interactive: { find_images: findImages },
        "scheduled-worker": { find_images: findImages },
      }),
  },
});
