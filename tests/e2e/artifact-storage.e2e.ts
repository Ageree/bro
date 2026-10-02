/**
 * The `/artifacts/<id>` route against the real bucket on Cloud.ru: an image
 * stored the way the agent stores one comes back through the route with its
 * type, size and ETag, a repeat with that ETag gets 304, and the test object
 * is deleted at the end. Only the session and the database row are faked.
 *
 *   BROWSER_STATE_BUCKET=… CLOUDRU_S3_TENANT_ID=… CLOUDRU_KEY_ID=… \
 *   CLOUDRU_KEY_SECRET=… DATABASE_URL=postgres://u:p@127.0.0.1:1/db \
 *   pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/artifact-storage.e2e.ts
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

const artifactId = randomUUID();
// A real PNG header and a random tail: a new object every run.
const png = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...crypto.getRandomValues(new Uint8Array(4096)),
]);
const contentHash = createHash("sha256").update(png).digest("hex");
const storagePathname = `e2e-checks/${contentHash}`;

vi.mock("@db/services/auth/session", () => ({
  getAuthSession: async () => await Promise.resolve({ user: { id: "e2e" } }),
}));
vi.mock("@db/services/artifacts", () => ({
  readReadyArtifact: async () =>
    await Promise.resolve({
      byteSize: png.byteLength,
      contentHash,
      filename: "e2e.png",
      id: artifactId,
      mediaType: "image/png",
      storagePathname,
    }),
}));

const objects = await import("@shared/object-storage/artifacts");
const { GET } = await import("@app/artifacts/[artifactId]/route");

afterAll(async () => {
  // Gone even when a check failed half way.
  await objects.deleteArtifactObject(storagePathname);
});

function open(headers?: HeadersInit) {
  return GET(
    new Request(`https://bro.example/artifacts/${artifactId}`, { headers }),
    { params: Promise.resolve({ artifactId }) }
  );
}

describe("artifacts in Object Storage", () => {
  it("serves what was stored, then answers 304 to its ETag", async () => {
    expect(objects.artifactStorageConfigured()).toBe(true);
    await objects.putArtifactObject({
      bytes: png,
      mediaType: "image/png",
      pathname: storagePathname,
    });

    const response = await open();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-length")).toBe(String(png.byteLength));
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox"
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    const etag = response.headers.get("etag");
    expect(etag).toBeTruthy();

    const again = await open({ "if-none-match": etag ?? "" });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
  });

  it("reads it back the way the channels do, checked by hash", async () => {
    const { readPrivateImage } =
      await import("@agent/lib/image-artifact/storage");
    expect(
      await readPrivateImage({
        byteSize: png.byteLength,
        contentHash,
        mediaType: "image/png",
        storagePathname,
      })
    ).toEqual(png);
  });

  it("deletes the object", async () => {
    await objects.deleteArtifactObject(storagePathname);
    expect(await objects.openArtifactObject(storagePathname)).toBeUndefined();
  });
});
