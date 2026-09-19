import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadWithin } from "./download";

const fetchMock =
  vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>();

/** A response as fetch reports it after following a redirect to `url`. */
function redirected(body: Uint8Array, url: string) {
  const response = new Response(new Uint8Array(body));
  Object.defineProperty(response, "url", { value: url });
  return response;
}

const bytes = new Uint8Array([1, 2, 3, 4]);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadWithin", () => {
  it("returns the bytes of an HTTPS resource", async () => {
    fetchMock.mockResolvedValueOnce(redirected(bytes, "https://cdn.example/a"));

    await expect(
      downloadWithin(new URL("https://cdn.example/a"), 16)
    ).resolves.toEqual({ bytes, kind: "bytes", mediaType: undefined });
  });

  it("refuses a plain HTTP URL without fetching", async () => {
    await expect(
      downloadWithin(new URL("http://cdn.example/a"), 16)
    ).resolves.toEqual({ kind: "failed", reason: "not-https" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a body that arrived through a redirect to plain HTTP", async () => {
    fetchMock.mockResolvedValueOnce(redirected(bytes, "http://cdn.example/a"));

    await expect(
      downloadWithin(new URL("https://cdn.example/a"), 16)
    ).resolves.toEqual({ kind: "failed", reason: "not-https" });
  });

  it("stops reading a body that grows past the cap", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(32)));

    await expect(
      downloadWithin(new URL("https://cdn.example/a"), 16)
    ).resolves.toEqual({ kind: "oversize" });
  });
});
