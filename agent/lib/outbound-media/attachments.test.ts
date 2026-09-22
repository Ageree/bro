import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  maximumAttachmentBytes,
  prepareAttachmentDelivery,
} from "./attachments";

const fetchMock =
  vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();

function bytesOf(head: readonly number[]) {
  const bytes = new Uint8Array(16);
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
