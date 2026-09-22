import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  maximumAttachmentBatchBytes,
  maximumAttachmentBytes,
  prepareAttachmentDelivery,
} from "./attachments";

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
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("keeps a file the host refused as a link", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));

    const delivery = await prepareAttachmentDelivery([
      { kind: "image", url: "https://media.example/missing.jpg" },
    ]);

    expect(delivery.failures).toEqual([
      { reason: "http 404", url: "https://media.example/missing.jpg" },
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
    "https://[::1]/photo.jpg",
    "https://localhost/photo.jpg",
    "https://printer.local/photo.jpg",
    "https://vault.internal/photo.jpg",
  ])("never fetches %s", async (url) => {
    const delivery = await prepareAttachmentDelivery([{ kind: "image", url }]);

    expect(delivery.failures).toEqual([{ reason: "blocked-host", url }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
