import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserPoolTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

const now = new Date("2026-09-30T12:00:00.000Z");

afterEach(() => {
  clearBrowserVmSettings();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

async function loadS3(settings = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  return importWithSettings(
    { ...browserPoolTestEnvironment, ...settings },
    async () => import("@agent/lib/browser-pool/s3")
  );
}

function stubStorage(...answers: readonly Response[]) {
  const calls: { method: string; url: string }[] = [];
  vi.stubGlobal("fetch", (url: string, init: { method: string }) => {
    calls.push({ method: init.method, url });
    const answer = answers[calls.length - 1];
    if (!answer) throw new Error("The test ran out of stubbed answers.");
    return Promise.resolve(answer);
  });
  return calls;
}

function listing(keys: readonly string[], next?: string) {
  const contents = keys
    .map((key) => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`)
    .join("");
  const truncated =
    next === undefined
      ? "<IsTruncated>false</IsTruncated>"
      : `<IsTruncated>true</IsTruncated><NextContinuationToken>${next}</NextContinuationToken>`;
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bro-state-test</Name>${truncated}${contents}</ListBucketResult>`,
    { status: 200 }
  );
}

describe("browser pool Object Storage", () => {
  // The presigned GET of the AWS Signature Version 4 documentation
  // ("Authenticating Requests: Using Query Parameters"), with its published
  // signature.
  it("presigns a URL exactly as the SigV4 example does", async () => {
    const s3 = await loadS3();

    expect(
      s3.presignS3Url({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        expiresSeconds: 86_400,
        method: "GET",
        now: new Date("2013-05-24T00:00:00.000Z"),
        region: "us-east-1",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        url: "https://examplebucket.s3.amazonaws.com/test.txt",
      })
    ).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    );
  });

  it("refuses a URL meant to outlive a week", async () => {
    const s3 = await loadS3();
    const input = {
      accessKeyId: "a",
      method: "GET" as const,
      now,
      region: "ru-central-1",
      secretAccessKey: "s",
      url: "https://s3.cloud.ru/b/k",
    };

    expect(() => s3.presignS3Url({ ...input, expiresSeconds: 0 })).toThrow(
      "A presigned URL lives"
    );
    expect(() =>
      s3.presignS3Url({ ...input, expiresSeconds: 7 * 86_400 + 1 })
    ).toThrow("A presigned URL lives");
  });

  it("signs the pool's objects path-style on Cloud.ru with the tenant's key", async () => {
    const s3 = await loadS3({
      CLOUDRU_KEY_SECRET: "“test-key-\nsecret”",
      CLOUDRU_S3_TENANT_ID: " test-tenant\n",
    });
    const url = s3.presignBrowserStateObject({
      expiresSeconds: 3_600,
      key: "sets/ws-abc/3/chunk-0000",
      method: "PUT",
      now,
    });

    expect(url).toMatch(
      /^https:\/\/s3\.cloud\.ru\/bro-state-test\/sets\/ws-abc\/3\/chunk-0000\?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=test-tenant%3Atest-key-id%2F20260930%2Fru-central-1%2Fs3%2Faws4_request&X-Amz-Date=20260930T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=[\da-f]{64}$/u
    );
    // The pasted secret is cleaned before it signs anything.
    expect(url).toBe(
      s3.presignS3Url({
        accessKeyId: "test-tenant:test-key-id",
        expiresSeconds: 3_600,
        method: "PUT",
        now,
        region: "ru-central-1",
        secretAccessKey: "test-key-secret",
        url: "https://s3.cloud.ru/bro-state-test/sets/ws-abc/3/chunk-0000",
      })
    );
  });

  it("lists every page of a prefix", async () => {
    const s3 = await loadS3();
    const calls = stubStorage(
      listing(
        ["sets/ws-abc/1/chunk-0000", "sets/ws-abc/1/manifest.json"],
        "t&amp;2"
      ),
      listing(["sets/ws-abc/2/a&amp;b"])
    );

    expect(await s3.listBrowserStateObjects("sets/ws-abc/")).toEqual([
      "sets/ws-abc/1/chunk-0000",
      "sets/ws-abc/1/manifest.json",
      "sets/ws-abc/2/a&b",
    ]);
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    const [first, second] = calls.map((call) => new URL(call.url));
    expect(first?.pathname).toBe("/bro-state-test");
    expect(first?.searchParams.get("list-type")).toBe("2");
    expect(first?.searchParams.get("prefix")).toBe("sets/ws-abc/");
    expect(first?.searchParams.has("continuation-token")).toBe(false);
    expect(second?.searchParams.get("continuation-token")).toBe("t&2");
    expect(second?.searchParams.get("X-Amz-Signature")).toMatch(
      /^[\da-f]{64}$/u
    );
  });

  it("deletes everything under a prefix, gone objects included", async () => {
    const s3 = await loadS3();
    const calls = stubStorage(
      listing(["sets/ws-abc/1/chunk-0000", "sets/ws-abc/1/manifest.json"]),
      new Response(null, { status: 204 }),
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
    );

    expect(await s3.deleteBrowserStateObjects("sets/ws-abc/")).toBe(2);
    expect(
      calls.slice(1).map((call) => [call.method, new URL(call.url).pathname])
    ).toEqual([
      ["DELETE", "/bro-state-test/sets/ws-abc/1/chunk-0000"],
      ["DELETE", "/bro-state-test/sets/ws-abc/1/manifest.json"],
    ]);
  });

  it("stops at a refusal, and never deletes by a bare prefix", async () => {
    const s3 = await loadS3();
    stubStorage(new Response("<Error>AccessDenied</Error>", { status: 403 }));

    await expect(s3.deleteBrowserStateObjects("sets/ws-abc/")).rejects.toThrow(
      s3.BrowserStateStoreError
    );
    await expect(s3.deleteBrowserStateObjects("sets/ws-abc")).rejects.toThrow(
      "slash"
    );
  });

  it("needs the tenant and the bucket", async () => {
    const s3 = await loadS3({ CLOUDRU_S3_TENANT_ID: "" });

    expect(() =>
      s3.presignBrowserStateObject({
        expiresSeconds: 60,
        key: "k",
        method: "GET",
      })
    ).toThrow("CLOUDRU_S3_TENANT_ID");
  });
});
