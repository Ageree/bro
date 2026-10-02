/* oxlint-disable vitest/require-mock-type-parameters -- The auth and object storage mocks implement only the route boundaries exercised here. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const artifactId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  openObject: vi.fn(),
  readArtifact: vi.fn(),
}));

vi.mock("@db/services/auth/session", () => ({
  getAuthSession: mocks.getAuthSession,
}));
vi.mock("@db/services/artifacts", () => ({
  readReadyArtifact: mocks.readArtifact,
}));
vi.mock("@shared/object-storage/artifacts", () => ({
  artifactStorageConfigured: () => true,
  openArtifactObject: mocks.openObject,
}));

import { GET } from "@app/artifacts/[artifactId]/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.readArtifact.mockResolvedValue({
    byteSize: png.byteLength,
    filename: "Product image.png",
    mediaType: "image/png",
    storagePathname: "artifacts/product",
  });
  mocks.openObject.mockResolvedValue({
    contentType: "image/png",
    etag: '"etag"',
    size: png.byteLength,
    status: 200,
    stream: new Response(png).body,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browser image route", () => {
  it("streams an authenticated artifact with private security headers", async () => {
    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'"
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain(
      "Product%20image.png"
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  it("downloads a non-image artifact instead of rendering it", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7");
    mocks.readArtifact.mockResolvedValue({
      byteSize: pdf.byteLength,
      filename: "Счёт.pdf",
      mediaType: "application/pdf",
      storagePathname: "gmail-attachments/invoice",
    });
    mocks.openObject.mockResolvedValue({
      contentType: "application/pdf",
      etag: '"etag"',
      size: pdf.byteLength,
      status: 200,
      stream: new Response(pdf).body,
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="____\.pdf"; filename\*=UTF-8''%D0%A1/u
    );
  });

  it("passes conditional ETags through to private storage", async () => {
    mocks.openObject.mockResolvedValue({ etag: '"etag"', status: 304 });

    const response = await GET(
      request({ "if-none-match": '"etag"' }),
      context()
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"etag"');
    expect(mocks.openObject).toHaveBeenCalledWith(
      "artifacts/product",
      expect.objectContaining({ ifNoneMatch: '"etag"' })
    );
  });

  it.each([
    ["unauthenticated", null, artifactId],
    ["invalid id", { user: { id: "user-1" } }, "not-an-id"],
  ])(
    "returns the same not-found response for %s requests",
    async (_name, session, id) => {
      mocks.getAuthSession.mockResolvedValue(session);

      const response = await GET(request(), context(id));

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
      expect(mocks.openObject).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["type", "text/html", png.byteLength],
    ["size", "image/png", png.byteLength + 1],
  ])(
    "refuses bytes whose %s differs from the row",
    async (_name, contentType, size) => {
      const cancel = vi.fn();
      mocks.openObject.mockResolvedValue({
        contentType,
        etag: '"etag"',
        size,
        status: 200,
        stream: new ReadableStream({ cancel }),
      });

      const response = await GET(request(), context());

      expect(response.status).toBe(404);
      expect(cancel).toHaveBeenCalledOnce();
    }
  );

  it("answers 502 when the body of a refused object cannot be cancelled", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    // A stream that already failed rejects its cancel with that failure.
    const dropped = new Error("connection reset");
    mocks.openObject.mockResolvedValue({
      contentType: "image/png",
      etag: '"etag"',
      size: png.byteLength + 1,
      status: 200,
      stream: new ReadableStream({
        start(controller) {
          controller.error(dropped);
        },
      }),
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(error).toHaveBeenCalledWith(
      "[artifacts] Object Storage read failed",
      dropped
    );
  });

  it("answers 502 with the private headers when storage fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.openObject.mockRejectedValue(new TypeError("fetch failed"));

    const response = await GET(request(), context());

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("leaves a database failure to the server, not to a storage 502", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.readArtifact.mockRejectedValue(new Error("database is down"));

    await expect(GET(request(), context())).rejects.toThrow("database is down");
    expect(mocks.openObject).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("does not reveal an unavailable or cross-workspace artifact", async () => {
    mocks.readArtifact.mockResolvedValue(undefined);

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });
});

function request(headers?: HeadersInit) {
  return new Request(`https://example.com/artifacts/${artifactId}`, {
    headers,
  });
}

function context(id = artifactId) {
  return { params: Promise.resolve({ artifactId: id }) };
}
