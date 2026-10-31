import type * as Dns from "node:dns";
import type * as PublicFetch from "@agent/lib/sandbox/public-fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSandboxSettings,
  importWithSandbox,
} from "@tests/helpers/sandbox";
import {
  maximumAttachmentBatchBytes,
  maximumAttachmentBytes,
  prepareAttachmentDelivery,
  taskFilesAttachmentLimits,
} from "./attachments";

/**
 * The names a test resolves; a hop the connection makes itself only when a
 * test asks for it (`dns.connect`), otherwise the stubbed global fetch.
 */
const dns = vi.hoisted(() => ({
  answer: new Array<Dns.LookupAddress>(),
  connect: false,
}));

vi.mock("node:dns", async (importOriginal) => {
  const original = await importOriginal<typeof Dns>();
  return {
    ...original,
    lookup: (
      _hostname: string,
      _options: Dns.LookupOptions,
      callback: (error: null, addresses: Dns.LookupAddress[]) => void
    ) => {
      callback(null, dns.answer);
    },
  };
});

vi.mock("@agent/lib/sandbox/public-fetch", async (importOriginal) => {
  const original = await importOriginal<typeof PublicFetch>();
  return {
    ...original,
    fetchPublic: (url: URL, init?: RequestInit) =>
      dns.connect ? original.fetchPublic(url, init) : fetch(url, init),
  };
});

const fetchMock =
  vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();

function bytesOf(head: readonly number[]) {
  const bytes = new Uint8Array(Math.max(16, head.length));
  bytes.set(head, 0);
  return bytes;
}

const jpeg = bytesOf([0xff, 0xd8, 0xff, 0xe0]);
const pdf = bytesOf([...Buffer.from("%PDF-1.7")]);
const zip = bytesOf([0x50, 0x4b, 0x03, 0x04]);

function served(bytes: Uint8Array, contentType?: string) {
  return new Response(new Uint8Array(bytes), {
    headers: contentType ? { "content-type": contentType } : {},
  });
}

function filledJpeg(size: number) {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return bytes;
}

/** A body whose size only shows up as it arrives, with no content-length. */
function streamed(size: number, contentType: string) {
  const chunk = filledJpeg(64 * 1024);
  let sent = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (sent >= size) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(new Uint8Array(chunk));
      },
    }),
    { headers: { "content-type": contentType } }
  );
}

beforeEach(() => {
  dns.answer = [];
  dns.connect = false;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  clearSandboxSettings();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function signedHtml(name = "Отчёт.html") {
  const modules = await importWithSandbox(async () => ({
    attachments: await import("./attachments"),
    files: await import("@agent/lib/sandbox/files"),
  }));
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
  const shared = await modules.files.shareSandboxFile({
    bytes: new TextEncoder().encode(
      "<!doctype html><html><body>Итог 🧭</body></html>"
    ),
    mediaType: "text/html",
    name,
  });
  fetchMock.mockReset();
  expect(modules.files.isSharedFileLink(shared.url)).toBe(true);
  return { ...shared, prepare: modules.attachments.prepareAttachmentDelivery };
}

describe("signed HTML document attachments", () => {
  it("follows the public storage redirect and normalizes a misleading name and type to HTML", async () => {
    const shared = await signedHtml();
    const bytes = new TextEncoder().encode(
      "<!doctype html><html><body>Итог 🧭</body></html>"
    );
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://storage.example.com/report" },
      })
    );
    fetchMock.mockResolvedValueOnce(served(bytes, "application/octet-stream"));
    const delivery = await shared.prepare([
      {
        kind: "file",
        url: shared.url,
        name: "Результат.pdf",
        mimeType: "image/jpeg",
      },
    ]);
    expect(delivery.failures).toEqual([]);
    expect(delivery.files[0]).toMatchObject({
      filename: "Результат.html",
      kind: "document",
      mimeType: "text/html",
      sourceUrl: shared.url,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0].toString()).toBe(
      "https://storage.example.com/report"
    );
  });

  it("keeps DNS-based SSRF protection for a genuine signed link", async () => {
    const shared = await signedHtml();
    dns.answer = [{ address: "127.0.0.1", family: 4 }];
    dns.connect = true;
    const delivery = await shared.prepare([{ kind: "file", url: shared.url }]);
    expect(delivery.failures).toEqual([
      { reason: "blocked-host", url: shared.url },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads an actual signed shared HTML file as a document", async () => {
    const shared = await signedHtml();
    const bytes = new TextEncoder().encode(
      "<!doctype html><html><body>Итог 🧭</body></html>"
    );
    fetchMock.mockResolvedValueOnce(served(bytes, "text/html; charset=utf-8"));
    const delivery = await shared.prepare([
      { kind: "file", url: shared.url, name: shared.name },
    ]);
    expect(delivery.failures).toEqual([]);
    expect(delivery.files).toEqual([
      {
        data: Buffer.from(bytes),
        filename: "Отчёт.html",
        kind: "document",
        mimeType: "text/html",
        sourceUrl: shared.url,
      },
    ]);
  });

  it.each(["signature", "origin", "path"] as const)(
    "rejects HTML after tampering with the %s of a genuine signed link",
    async (change) => {
      const shared = await signedHtml();
      const url = new URL(shared.url);
      if (change === "signature") url.searchParams.set("sig", "forged");
      if (change === "origin") url.hostname = "external.example.com";
      if (change === "path") url.pathname = "/ordinary-page.html";
      fetchMock.mockResolvedValueOnce(
        served(
          new TextEncoder().encode("<!doctype html><html>page</html>"),
          "text/html"
        )
      );
      const delivery = await shared.prepare([
        {
          kind: "file",
          url: url.href,
          name: "Отчёт.html",
          mimeType: "text/html",
        },
      ]);
      expect(delivery.files).toEqual([]);
      expect(delivery.failures).toEqual([
        { reason: "not-a-file", url: url.href },
      ]);
    }
  );

  it("does not treat a signed non-HTML filename as permission to upload a page", async () => {
    const shared = await signedHtml("Отчёт.pdf");
    fetchMock.mockResolvedValueOnce(
      served(
        new TextEncoder().encode("<!doctype html><html>page</html>"),
        "text/html"
      )
    );
    const delivery = await shared.prepare([
      { kind: "file", url: shared.url, name: "Отчёт.html" },
    ]);
    expect(delivery.failures).toEqual([
      { reason: "not-a-file", url: shared.url },
    ]);
  });

  it("does not trust a final redirect to a signed file when the original URL is an ordinary page", async () => {
    const shared = await signedHtml();
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: shared.url } })
    );
    fetchMock.mockResolvedValueOnce(
      served(
        new TextEncoder().encode("<!doctype html><html>page</html>"),
        "text/html"
      )
    );
    const url = "https://external.example.com/page.html";
    const delivery = await shared.prepare([{ kind: "file", url }]);
    expect(delivery.failures).toEqual([{ reason: "not-a-file", url }]);
  });

  it("preserves byte caps for signed HTML", async () => {
    const shared = await signedHtml();
    fetchMock.mockResolvedValueOnce(
      new Response("<!doctype html>", {
        headers: {
          "content-type": "text/html",
          "content-length": String(maximumAttachmentBytes + 1),
        },
      })
    );
    expect(
      (await shared.prepare([{ kind: "file", url: shared.url }])).failures
    ).toEqual([{ reason: "oversize", url: shared.url }]);
  });

  it("preserves HTTP error handling for signed HTML", async () => {
    const shared = await signedHtml();
    fetchMock.mockResolvedValueOnce(
      new Response("<!doctype html><html>Error</html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      })
    );
    const delivery = await shared.prepare([{ kind: "file", url: shared.url }]);
    expect(delivery.files).toEqual([]);
    expect(delivery.failures).toEqual([
      { reason: "http 403", url: shared.url },
    ]);
  });

  it("still rejects a signed file's redirect to a private host before fetching it", async () => {
    const shared = await signedHtml();
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/private.html" },
      })
    );
    const delivery = await shared.prepare([{ kind: "file", url: shared.url }]);
    expect(delivery.failures).toEqual([
      { reason: "blocked-host", url: shared.url },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("prepareAttachmentDelivery", () => {
  it("uploads image bytes as a photo named for its real type", async () => {
    fetchMock.mockResolvedValueOnce(served(jpeg, "image/jpeg"));

    const delivery = await prepareAttachmentDelivery([
      { kind: "image", url: "https://media.example/photos/sunset" },
    ]);

    expect(delivery.failures).toEqual([]);
    expect(delivery.files).toEqual([
      {
        data: Buffer.from(jpeg),
        filename: "sunset.jpg",
        kind: "photo",
        mimeType: "image/jpeg",
        sourceUrl: "https://media.example/photos/sunset",
      },
    ]);
  });

  it("trusts the bytes over a media type the model declared", async () => {
    fetchMock.mockResolvedValueOnce(served(pdf, "application/octet-stream"));

    const delivery = await prepareAttachmentDelivery([
      {
        kind: "image",
        mimeType: "image/png",
        name: "brief.png",
        url: "https://media.example/brief",
      },
    ]);

    expect(delivery.files).toEqual([
      expect.objectContaining({
        filename: "brief.pdf",
        kind: "document",
        mimeType: "application/pdf",
      }),
    ]);
  });

  it("uploads a media type it has no extension for under its own name", async () => {
    fetchMock.mockResolvedValueOnce(served(zip, "application/zip"));

    const delivery = await prepareAttachmentDelivery([
      {
        kind: "file",
        name: "trip-photos",
        url: "https://media.example/trip.zip",
      },
    ]);

    expect(delivery.files).toEqual([
      expect.objectContaining({
        filename: "trip-photos",
        kind: "document",
        mimeType: "application/zip",
      }),
    ]);
  });

  it("names a file after the URL path when the model named none", async () => {
    fetchMock.mockResolvedValueOnce(served(jpeg, "image/jpeg"));

    const delivery = await prepareAttachmentDelivery([
      {
        kind: "image",
        url: "https://media.example/gallery/summer%20trip.jpg?width=800",
      },
    ]);

    expect(delivery.files[0]?.filename).toBe("summer trip.jpg");
  });

  it("falls back to a plain name when the URL path has none", async () => {
    fetchMock.mockResolvedValueOnce(served(jpeg, "image/jpeg"));

    const delivery = await prepareAttachmentDelivery([
      { kind: "image", url: "https://media.example/" },
    ]);

    expect(delivery.files[0]?.filename).toBe("attachment-1.jpg");
  });

  it("keeps an oversized file as a link instead of buffering it", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(jpeg), {
        headers: {
          "content-length": String(maximumAttachmentBytes + 1),
          "content-type": "image/jpeg",
        },
      })
    );

    const delivery = await prepareAttachmentDelivery([
      { kind: "image", url: "https://media.example/huge.jpg" },
    ]);

    expect(delivery.files).toEqual([]);
    expect(delivery.failures).toEqual([
      { reason: "oversize", url: "https://media.example/huge.jpg" },
    ]);
  });

  it("keeps a page as a link rather than uploading its markup", async () => {
    fetchMock.mockResolvedValueOnce(
      served(bytesOf([...Buffer.from("<!doctype html>")]), "text/html")
    );

    const delivery = await prepareAttachmentDelivery([
      { kind: "image", url: "https://example.com/gallery" },
    ]);

    expect(delivery.failures).toEqual([
      { reason: "not-a-file", url: "https://example.com/gallery" },
    ]);
  });

  it("refuses a plain HTTP URL without fetching", async () => {
    const delivery = await prepareAttachmentDelivery([
      { kind: "image", url: "http://media.example/photo.jpg" },
    ]);

    expect(delivery.failures).toEqual([
      { reason: "not-https", url: "http://media.example/photo.jpg" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/photo.jpg",
    "https://printer.local/photo.jpg",
    "https://vault.internal/photo.jpg",
  ])("never fetches %s", async (url) => {
    const delivery = await prepareAttachmentDelivery([{ kind: "image", url }]);

    expect(delivery.failures).toEqual([{ reason: "blocked-host", url }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "::1"])(
    "never connects to a name that resolves to %s",
    async (address) => {
      dns.answer = [{ address, family: address.includes(":") ? 6 : 4 }];
      dns.connect = true;
      fetchMock.mockResolvedValue(served(jpeg, "image/jpeg"));
      const url = "https://rebind.example/photo.jpg";

      const delivery = await prepareAttachmentDelivery([
        { kind: "image", url },
      ]);

      expect(delivery.failures).toEqual([{ reason: "blocked-host", url }]);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("keeps markup served as an image as a link", async () => {
    fetchMock.mockResolvedValueOnce(
      served(bytesOf([...Buffer.from("<!DOCTYPE html><html>")]), "image/jpeg")
    );

    const delivery = await prepareAttachmentDelivery([
      { kind: "image", url: "https://example.com/photo.jpg" },
    ]);

    expect(delivery.failures).toEqual([
      { reason: "not-a-file", url: "https://example.com/photo.jpg" },
    ]);
  });

  it("keeps a body that streams past the cap as a link", async () => {
    fetchMock.mockResolvedValueOnce(
      streamed(maximumAttachmentBytes + 1024, "image/jpeg")
    );

    const delivery = await prepareAttachmentDelivery([
      { kind: "image", url: "https://media.example/huge.jpg" },
    ]);

    expect(delivery.failures).toEqual([
      { reason: "oversize", url: "https://media.example/huge.jpg" },
    ]);
  });

  it("never fetches a redirect target that points at a blocked host", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        headers: { location: "https://169.254.169.254/latest" },
        status: 302,
      })
    );

    const delivery = await prepareAttachmentDelivery([
      { kind: "image", url: "https://media.example/redirect" },
    ]);

    expect(delivery.failures).toEqual([
      { reason: "blocked-host", url: "https://media.example/redirect" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops downloading once the message has spent its byte budget", async () => {
    fetchMock.mockImplementation(async () =>
      served(filledJpeg(maximumAttachmentBytes), "image/jpeg")
    );
    const urls = [1, 2, 3, 4].map(
      (index) => `https://media.example/photo-${String(index)}.jpg`
    );

    const delivery = await prepareAttachmentDelivery(
      urls.map((url) => ({ kind: "image", url }) as const)
    );

    expect(
      delivery.files.reduce((total, file) => total + file.data.byteLength, 0)
    ).toBe(maximumAttachmentBatchBytes);
    expect(delivery.files).toHaveLength(3);
    expect(delivery.failures).toEqual([
      { reason: "batch-oversize", url: urls[3] },
    ]);
    // The fourth attachment is never requested: the budget is already gone.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends files up to 20 MB, 50 MB a message, in the files pilot", async () => {
    const megabytes = 1024 * 1024;
    fetchMock.mockImplementation(async () =>
      served(filledJpeg(15 * megabytes), "image/jpeg")
    );
    const urls = [1, 2, 3, 4].map(
      (index) => `https://media.example/scan-${String(index)}.jpg`
    );
    const scans = urls.map((url) => ({ kind: "image", url }) as const);

    const standard = await prepareAttachmentDelivery(scans.slice(0, 1));
    expect(standard.failures).toEqual([{ reason: "oversize", url: urls[0] }]);

    const pilot = await prepareAttachmentDelivery(
      scans,
      taskFilesAttachmentLimits
    );
    expect(pilot.files).toHaveLength(3);
    expect(pilot.failures).toEqual([
      { reason: "batch-oversize", url: urls[3] },
    ]);
  });

  it("strips path separators and invisible characters from a name", async () => {
    fetchMock.mockResolvedValueOnce(served(jpeg, "image/jpeg"));

    const delivery = await prepareAttachmentDelivery([
      {
        kind: "image",
        name: "../secrets\n\u202Egpj.evil",
        url: "https://media.example/photo.jpg",
      },
    ]);

    expect(delivery.files[0]?.filename).toBe("..secretsgpj.jpg");
  });

  it("keeps a dotted name and appends the extension", async () => {
    fetchMock.mockResolvedValueOnce(served(jpeg, "image/jpeg"));

    const delivery = await prepareAttachmentDelivery([
      {
        kind: "image",
        name: "2024.06.wedding",
        url: "https://media.example/photo",
      },
    ]);

    expect(delivery.files[0]?.filename).toBe("2024.06.wedding.jpg");
  });

  it("keeps an attachment that broke in an unforeseen way as a link", async () => {
    const response = served(jpeg, "image/jpeg");
    // A response whose own fields throw escapes every guard the download has.
    Object.defineProperty(response, "url", {
      get() {
        throw new Error("torn down mid-read");
      },
    });
    fetchMock.mockResolvedValueOnce(response);

    const delivery = await prepareAttachmentDelivery([
      { kind: "image", url: "https://media.example/photo.jpg" },
    ]);

    expect(delivery.files).toEqual([]);
    expect(delivery.failures).toEqual([
      { reason: "unexpected", url: "https://media.example/photo.jpg" },
    ]);
  });

  it("delivers the attachments it could fetch and links the rest", async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("broken.jpg")
        ? new Response("", { status: 500 })
        : served(jpeg, "image/jpeg")
    );

    const delivery = await prepareAttachmentDelivery([
      { kind: "image", url: "https://media.example/first.jpg" },
      { kind: "image", url: "https://media.example/broken.jpg" },
      { kind: "image", url: "https://media.example/third.jpg" },
    ]);

    expect(delivery.files.map((file) => file.filename)).toEqual([
      "first.jpg",
      "third.jpg",
    ]);
    expect(delivery.failures).toEqual([
      { reason: "http 500", url: "https://media.example/broken.jpg" },
    ]);
  });
});
