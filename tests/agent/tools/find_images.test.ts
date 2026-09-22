import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import findImages from "@agent/tools/find_images";

const fetchMock =
  vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();
const routes = new Map<string, () => Response>();

const pageUrl = "https://listing.example/flats/42";

/** A JPEG of `size` bytes whose frame header reports `width` × `height`. */
function jpeg(width: number, height: number, size = 120_000) {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
  bytes.set([...Buffer.from("JFIF\0")], 6);
  bytes.set(
    [
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
    ],
    20
  );
  return bytes;
}

/** How an image CDN answers a `Range: bytes=0-4095` probe. */
function imageAt(url: string, bytes: Uint8Array, contentType = "image/jpeg") {
  routes.set(
    url,
    () =>
      new Response(bytes.slice(0, 4096), {
        headers: {
          "content-range": `bytes 0-4095/${String(bytes.byteLength)}`,
          "content-type": contentType,
        },
        status: 206,
      })
  );
}

function pageAt(url: string, html: string, status = 200) {
  routes.set(
    url,
    () =>
      new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
        status,
      })
  );
}

function redirectAt(url: string, location: string) {
  routes.set(
    url,
    () => new Response(null, { headers: { location }, status: 302 })
  );
}

function requested() {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

async function find(url = pageUrl, limit?: number) {
  const output = await findImages.execute({ limit, url }, toolContext());
  if (Symbol.asyncIterator in output) {
    throw new Error("find_images must return its result directly.");
  }
  return output;
}

beforeEach(() => {
  routes.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation((url) => {
    const route = routes.get(String(url));
    return Promise.resolve(
      route ? route() : new Response(null, { status: 404 })
    );
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("find_images", () => {
  it("resolves relative sources against the page and reports the photo", async () => {
    pageAt(
      pageUrl,
      `<html><head><title>Двушка на Тверской</title></head><body>
        <img src="photos/living-room.jpg" alt="Гостиная">
        <img src="/photos/kitchen.jpg">
      </body></html>`
    );
    imageAt(
      "https://listing.example/flats/photos/living-room.jpg",
      jpeg(1280, 960)
    );
    imageAt(
      "https://listing.example/photos/kitchen.jpg",
      jpeg(1024, 768, 90_000)
    );

    await expect(find()).resolves.toEqual({
      images: [
        {
          alt: "Гостиная",
          bytes: 120_000,
          height: 960,
          mimeType: "image/jpeg",
          url: "https://listing.example/flats/photos/living-room.jpg",
          width: 1280,
        },
        {
          bytes: 90_000,
          height: 768,
          mimeType: "image/jpeg",
          url: "https://listing.example/photos/kitchen.jpg",
          width: 1024,
        },
      ],
      pageTitle: "Двушка на Тверской",
    });
  });

  it("takes the largest srcset entry, including URLs with commas", async () => {
    pageAt(
      pageUrl,
      `<img src="/small.jpg" srcset="https://cdn.example/c_fill,w_320/room.jpg 320w, https://cdn.example/c_fill,w_1600/room.jpg 1600w, https://cdn.example/c_fill,w_800/room.jpg 800w">`
    );
    imageAt("https://cdn.example/c_fill,w_1600/room.jpg", jpeg(1600, 1200));

    const result = await find();

    expect(result.images.map((image) => image.url)).toEqual([
      "https://cdn.example/c_fill,w_1600/room.jpg",
    ]);
    expect(requested()).not.toContain("https://listing.example/small.jpg");
  });

  it("reads the lazy data-src instead of the placeholder in src", async () => {
    pageAt(
      pageUrl,
      `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/lazy/bedroom.jpg" alt="Спальня">`
    );
    imageAt("https://listing.example/lazy/bedroom.jpg", jpeg(1200, 800));

    const result = await find();

    expect(result.images).toEqual([
      expect.objectContaining({
        alt: "Спальня",
        url: "https://listing.example/lazy/bedroom.jpg",
      }),
    ]);
  });

  it("puts og:image first even when a gallery photo is larger", async () => {
    pageAt(
      pageUrl,
      `<html><head>
        <meta property="og:title" content="Квартира 54 м²">
        <meta property="og:image" content="https://img.example/cover.jpg">
      </head><body><img src="https://img.example/big.jpg"></body></html>`
    );
    imageAt("https://img.example/cover.jpg", jpeg(1200, 630, 60_000));
    imageAt("https://img.example/big.jpg", jpeg(2400, 1600, 900_000));

    const result = await find();

    expect(result.pageTitle).toBe("Квартира 54 м²");
    expect(result.images.map((image) => image.url)).toEqual([
      "https://img.example/cover.jpg",
      "https://img.example/big.jpg",
    ]);
  });

  it("collects picture sources, image_src, and JSON-LD photos", async () => {
    pageAt(
      pageUrl,
      `<head><link rel="image_src" href="/share.jpg">
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Residence","image":[{"@type":"ImageObject","contentUrl":"https://img.example/ld-1.jpg"},"https://img.example/ld-2.jpg"]}]}</script></head>
      <body><picture><source type="image/avif" srcset="/hall.avif"><source type="image/webp" srcset="/hall.webp 1x, /hall@2x.webp 2x"></picture></body>`
    );
    for (const [index, url] of [
      "https://listing.example/share.jpg",
      "https://listing.example/hall@2x.webp",
      "https://img.example/ld-1.jpg",
      "https://img.example/ld-2.jpg",
    ].entries()) {
      imageAt(url, jpeg(1000, 700, 100_000 + index));
    }

    const result = await find(pageUrl, 10);

    expect(result.images.map((image) => image.url).toSorted()).toEqual([
      "https://img.example/ld-1.jpg",
      "https://img.example/ld-2.jpg",
      "https://listing.example/hall@2x.webp",
      "https://listing.example/share.jpg",
    ]);
    expect(requested()).not.toContain("https://listing.example/hall.avif");
  });

  it("drops icons, logos, sprites, svg, pixels and small declared sizes without probing them", async () => {
    pageAt(
      pageUrl,
      `<img src="/static/icons/phone.png">
       <img src="/img/logo-dark.png">
       <img src="/img/sprite.png">
       <img src="/img/map.svg">
       <img src="https://mc.yandex.ru/watch/123">
       <img src="/img/thumb.jpg" width="120" height="90">
       <img src="/img/room.jpg" width="1200" height="800">`
    );
    imageAt("https://listing.example/img/room.jpg", jpeg(1200, 800));

    const result = await find();

    expect(result.images.map((image) => image.url)).toEqual([
      "https://listing.example/img/room.jpg",
    ]);
    expect(requested()).toEqual([
      pageUrl,
      "https://listing.example/img/room.jpg",
    ]);
  });

  it("keeps only candidates that download as a sized image", async () => {
    pageAt(
      pageUrl,
      `<img src="/not-an-image.jpg"><img src="/tiny.jpg"><img src="/gone.jpg"><img src="/ok.jpg">`
    );
    routes.set(
      "https://listing.example/not-an-image.jpg",
      () =>
        new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        })
    );
    imageAt("https://listing.example/tiny.jpg", jpeg(50, 50, 800));
    imageAt("https://listing.example/ok.jpg", jpeg(900, 600));

    const result = await find();

    expect(result.images.map((image) => image.url)).toEqual([
      "https://listing.example/ok.jpg",
    ]);
  });

  it("refuses a page that redirects to a blocked host", async () => {
    redirectAt(pageUrl, "https://127.0.0.1/admin");

    await expect(find()).rejects.toThrow(/blocked host/u);
    expect(requested()).toEqual([pageUrl]);
  });

  it("drops an image whose redirect leads to a blocked host", async () => {
    pageAt(pageUrl, `<img src="/redirected.jpg"><img src="/fine.jpg">`);
    redirectAt(
      "https://listing.example/redirected.jpg",
      "https://localhost/secret.jpg"
    );
    imageAt("https://listing.example/fine.jpg", jpeg(800, 600));

    const result = await find();

    expect(result.images.map((image) => image.url)).toEqual([
      "https://listing.example/fine.jpg",
    ]);
    expect(requested()).not.toContain("https://localhost/secret.jpg");
  });

  it("says plainly when the site answers with an anti-bot check", async () => {
    pageAt(
      pageUrl,
      "<html><head><title>Just a moment...</title></head><body></body></html>",
      403
    );

    await expect(find()).rejects.toThrow(/anti-bot/u);
  });

  it("treats a redirect to a captcha page as an anti-bot check", async () => {
    redirectAt(pageUrl, "/cian-captcha/?redirect_url=https://listing.example/");

    await expect(find()).rejects.toThrow(/anti-bot/u);
    expect(requested()).toEqual([pageUrl]);
  });

  it("does not mistake a large article that mentions a captcha for a check page", async () => {
    pageAt(
      pageUrl,
      `<html><head><title>Eiffel Tower</title><script>var config = {"wgShowCaptcha": false};</script></head><body>${"<p>History</p>".repeat(20_000)}<img src="/tower.jpg"></body></html>`
    );
    imageAt("https://listing.example/tower.jpg", jpeg(1200, 1800));

    const result = await find();

    expect(result.images.map((image) => image.url)).toEqual([
      "https://listing.example/tower.jpg",
    ]);
  });

  it("recognises a challenge page served with 200", async () => {
    pageAt(
      pageUrl,
      "<html><head><title>Доступ ограничен: проблема с IP</title></head></html>"
    );

    await expect(find()).rejects.toThrow(/anti-bot/u);
  });

  it("explains an empty result instead of returning nothing", async () => {
    pageAt(pageUrl, "<html><body><div id=root></div></body></html>");

    const result = await find();

    expect(result.images).toEqual([]);
    expect(result.notice).toMatch(/JavaScript/u);
  });

  it("caps the result at the requested limit", async () => {
    pageAt(
      pageUrl,
      [1, 2, 3, 4].map((index) => `<img src="/p${String(index)}.jpg">`).join("")
    );
    for (const index of [1, 2, 3, 4]) {
      imageAt(
        `https://listing.example/p${String(index)}.jpg`,
        jpeg(1000, 800, 100_000 + index)
      );
    }

    const result = await find(pageUrl, 2);

    expect(result.images).toHaveLength(2);
  });
});

function toolContext() {
  return focusedToolContext({});
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This test adapter deliberately accepts a focused structural fixture.
function focusedToolContext(value: unknown): ToolContext {
  // SAFETY: find_images never reads its tool context.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A complete tool context would add unrelated runtime handles.
  return value as ToolContext;
}
