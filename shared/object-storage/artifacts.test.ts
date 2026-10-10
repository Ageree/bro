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
  vi.restoreAllMocks();
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

  it("gives an upload a deadline that grows with its body", async () => {
    stubStorage(new Response(null, { status: 200 }));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const artifacts = await import("@shared/object-storage/artifacts");
    const { uploadTimeoutMs } =
      await import("@shared/object-storage/upload-timeout");
    const bytes = new Uint8Array(10 * 1024 * 1024);

    await artifacts.putArtifactObject({
      bytes,
      mediaType: "application/pdf",
      pathname: "gmail-attachments/u/big",
    });

    expect(timeout).toHaveBeenCalledWith(uploadTimeoutMs(bytes.byteLength));
    expect(uploadTimeoutMs(bytes.byteLength)).toBeGreaterThan(
      uploadTimeoutMs(1)
    );
  });

  it("fails a refused upload, naming the cause Object Storage gave", async () => {
    stubStorage(
      new Response("<Error><Code>SignatureDoesNotMatch</Code></Error>", {
        status: 403,
      })
    );
    const artifacts = await import("@shared/object-storage/artifacts");

    const upload = artifacts.putArtifactObject({
      bytes: new Uint8Array([1]),
      mediaType: "image/png",
      pathname: "generated-images/u/x",
    });
    await expect(upload).rejects.toThrow(artifacts.ArtifactStorageError);
    await expect(upload).rejects.toThrow(/SignatureDoesNotMatch/u);
  });

  it("refuses a path with a . or .. segment before any request", async () => {
    const calls = stubStorage();
    const artifacts = await import("@shared/object-storage/artifacts");

    for (const pathname of ["generated-images/../x", "./x", "a/./b"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each path is checked on its own.
      await expect(
        artifacts.putArtifactObject({
          bytes: new Uint8Array([1]),
          mediaType: "image/png",
          pathname,
        })
      ).rejects.toThrow(/\.\. segment/u);
    }
    expect(calls).toHaveLength(0);
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

  it("reads a missing bucket as an outage, not a missing object", async () => {
    stubStorage(
      new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 })
    );
    const artifacts = await import("@shared/object-storage/artifacts");

    await expect(artifacts.openArtifactObject("a/b")).rejects.toThrow(
      /NoSuchBucket/u
    );
  });

  it("bounds each read of the body, not the whole of a slow download", async () => {
    vi.useFakeTimers();
    try {
      let sent = 0;
      let aborted = false;
      vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                sent += 1;
                if (sent > 3) {
                  // Object Storage stops answering mid-body.
                  await new Promise<never>((_resolve, reject) => {
                    init.signal?.addEventListener("abort", () => {
                      reject(new Error("aborted"));
                    });
                  });
                }
                controller.enqueue(new Uint8Array([sent]));
              },
            }),
            {
              headers: { "content-length": "4", "content-type": "image/png" },
              status: 200,
            }
          )
        );
      });
      const artifacts = await import("@shared/object-storage/artifacts");

      const opened = await artifacts.openArtifactObject("a/b");
      if (opened?.status !== 200) throw new Error("Expected a body.");
      const reader = opened.stream.getReader();
      // A slow reader: minutes between reads do not cut the download.
      for (let read = 1; read <= 3; read += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Reads are ordered.
        expect((await reader.read()).value).toEqual(new Uint8Array([read]));
        // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
        await vi.advanceTimersByTimeAsync(120_000);
      }
      expect(aborted).toBe(false);
      // A read Object Storage never answers errors the stream, not ends it.
      const stalled = reader.read().then(
        () => "ended",
        () => "errored"
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await stalled).toBe("errored");
      expect(aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes, counting an object already gone as deleted", async () => {
    const calls = stubStorage(
      new Response(null, { status: 204 }),
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
      new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 })
    );
    const artifacts = await import("@shared/object-storage/artifacts");

    await artifacts.deleteArtifactObject("gmail-attachments/w/1");
    await artifacts.deleteArtifactObject("gmail-attachments/w/1");
    await expect(
      artifacts.deleteArtifactObject("gmail-attachments/w/1")
    ).rejects.toThrow(/NoSuchBucket/u);

    expect(calls.map((call) => call.method)).toEqual([
      "DELETE",
      "DELETE",
      "DELETE",
    ]);
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

describe("another S3 provider", () => {
  const selectel = {
    S3_ACCESS_KEY_ID: "selectel-key",
    S3_ENDPOINT: "https://s3.ru-1.storage.selcloud.ru",
    S3_REGION: "ru-1",
    S3_SECRET_ACCESS_KEY: "selectel-secret",
  };

  afterEach(() => {
    for (const name of Object.keys(selectel)) vi.stubEnv(name, "");
  });

  it("signs for the S3_* endpoint, region and plain key, not Cloud.ru's", async () => {
    for (const [name, value] of Object.entries(selectel))
      vi.stubEnv(name, value);
    const calls = stubStorage(new Response(null, { status: 200 }));
    const artifacts = await import("@shared/object-storage/artifacts");

    await artifacts.putArtifactObject({
      bytes: new Uint8Array([1]),
      mediaType: "image/png",
      pathname: "generated-images/a",
    });

    expect(calls[0]?.url.origin).toBe("https://s3.ru-1.storage.selcloud.ru");
    expect(calls[0]?.url.pathname).toBe(
      "/bro-state-test/artifacts/generated-images/a"
    );
    expect(calls[0]?.url.searchParams.get("X-Amz-Credential")).toMatch(
      /^selectel-key\/\d{8}\/ru-1\/s3\/aws4_request$/u
    );
  });

  it("counts as configured with the S3_* key alone, without Cloud.ru's", async () => {
    for (const name of [
      "CLOUDRU_KEY_ID",
      "CLOUDRU_KEY_SECRET",
      "CLOUDRU_S3_TENANT_ID",
    ])
      vi.stubEnv(name, "");
    for (const [name, value] of Object.entries(selectel))
      vi.stubEnv(name, value);
    const { objectStorageConfigured, objectStore } =
      await import("@shared/object-storage/s3");

    expect(objectStorageConfigured()).toBe(true);
    expect(objectStore()).toMatchObject({
      endpoint: "https://s3.ru-1.storage.selcloud.ru",
      region: "ru-1",
    });
  });

  it("refuses a half-set S3_* config at start", async () => {
    vi.stubEnv("S3_ACCESS_KEY_ID", "selectel-key");
    await expect(import("@shared/environment")).rejects.toThrow(
      /S3_ENDPOINT|Invalid environment variables/u
    );
  });
});
