import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = {
  BROWSER_STATE_BUCKET: "bro-state-test",
  CLOUDRU_KEY_ID: "test-key-id",
  CLOUDRU_KEY_SECRET: "test-key-secret",
  CLOUDRU_S3_TENANT_ID: "test-tenant",
};

interface Call {
  readonly headers: Headers;
  readonly method: string;
  readonly url: URL;
}

beforeEach(() => {
  vi.resetModules();
  for (const [name, value] of Object.entries(storage)) vi.stubEnv(name, value);
});

afterEach(() => {
  for (const name of Object.keys(storage)) vi.stubEnv(name, "");
  vi.unstubAllGlobals();
});

function stubStorage(...answers: readonly Response[]) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({
      headers: new Headers(init.headers),
      method: init.method ?? "GET",
      url: new URL(url),
    });
    const answer = answers[calls.length - 1];
    if (!answer) throw new Error("The test ran out of stubbed answers.");
    return Promise.resolve(answer);
  });
  return calls;
}

describe("artifact objects", () => {
  it("stores under artifacts/ plus the row's path, with its type", async () => {
    const calls = stubStorage(new Response(null, { status: 200 }));
    const artifacts = await import("@shared/object-storage/artifacts");

    await artifacts.putArtifactObject({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
      pathname: "browser-images/better-auth-alice/abc",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url.pathname).toBe(
      "/bro-state-test/artifacts/browser-images/better-auth-alice/abc"
    );
    expect(calls[0]?.url.searchParams.get("X-Amz-Credential")).toMatch(
      /^test-tenant:test-key-id\//u
    );
    expect(calls[0]?.headers.get("content-type")).toBe("image/png");
  });

  it("fails a refused upload", async () => {
    stubStorage(new Response("<Error/>", { status: 403 }));
    const artifacts = await import("@shared/object-storage/artifacts");

    await expect(
      artifacts.putArtifactObject({
        bytes: new Uint8Array([1]),
        mediaType: "image/png",
        pathname: "generated-images/u/x",
      })
    ).rejects.toThrow(artifacts.ArtifactStorageError);
  });

  it("streams an object with its size, type and ETag", async () => {
    stubStorage(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "content-length": "3",
          "content-type": "image/png",
          etag: '"md5"',
        },
        status: 200,
      })
    );
    const artifacts = await import("@shared/object-storage/artifacts");

    const opened = await artifacts.openArtifactObject("generated-images/u/x");

    expect(opened).toMatchObject({
      contentType: "image/png",
      etag: '"md5"',
      size: 3,
      status: 200,
    });
    if (opened?.status !== 200) throw new Error("Expected a body.");
    expect(
      new Uint8Array(await new Response(opened.stream).arrayBuffer())
    ).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("passes the reader's ETag on and answers 304", async () => {
    const calls = stubStorage(
      new Response(null, { headers: { etag: '"md5"' }, status: 304 })
    );
    const artifacts = await import("@shared/object-storage/artifacts");

    expect(
      await artifacts.openArtifactObject("generated-images/u/x", {
        ifNoneMatch: '"md5"',
      })
    ).toEqual({ etag: '"md5"', status: 304 });
    expect(calls[0]?.headers.get("if-none-match")).toBe('"md5"');
  });

  it("keeps the reader's ETag when a 304 carries none", async () => {
    stubStorage(new Response(null, { status: 304 }));
    const artifacts = await import("@shared/object-storage/artifacts");

    expect(
      await artifacts.openArtifactObject("generated-images/u/x", {
        ifNoneMatch: '"md5"',
      })
    ).toEqual({ etag: '"md5"', status: 304 });
  });

  it("reads a missing object as nothing and a refusal as an error", async () => {
    stubStorage(
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
      new Response("<Error/>", { status: 403 })
    );
    const artifacts = await import("@shared/object-storage/artifacts");

    expect(await artifacts.openArtifactObject("a/b")).toBeUndefined();
    await expect(artifacts.openArtifactObject("a/b")).rejects.toThrow(
      artifacts.ArtifactStorageError
    );
  });

  it("deletes, counting an object already gone as deleted", async () => {
    const calls = stubStorage(
      new Response(null, { status: 204 }),
      new Response(null, { status: 404 })
    );
    const artifacts = await import("@shared/object-storage/artifacts");

    await artifacts.deleteArtifactObject("gmail-attachments/w/1");
    await artifacts.deleteArtifactObject("gmail-attachments/w/1");

    expect(calls.map((call) => call.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("is configured only with the bucket and its key", async () => {
    const artifacts = await import("@shared/object-storage/artifacts");
    expect(artifacts.artifactStorageConfigured()).toBe(true);

    vi.resetModules();
    vi.stubEnv("CLOUDRU_KEY_SECRET", "");
    const unconfigured = await import("@shared/object-storage/artifacts");
    expect(unconfigured.artifactStorageConfigured()).toBe(false);
  });
});
