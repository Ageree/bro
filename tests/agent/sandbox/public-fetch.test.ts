import type * as Dns from "node:dns";
import { EventEmitter } from "node:events";
import type * as Https from "node:https";
import { Readable } from "node:stream";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  clearSandboxSettings,
  importWithSandbox,
} from "@tests/helpers/sandbox";

/** What the name resolves to: the sandbox tool router must not go there. */
const dns = vi.hoisted(() => ({
  answer: new Array<Dns.LookupAddress>(),
  asked: new Array<string>(),
}));

vi.mock("node:dns", async (importOriginal) => {
  const original = await importOriginal<typeof Dns>();
  return {
    ...original,
    lookup: (
      hostname: string,
      _options: Dns.LookupOptions,
      callback: (error: null, addresses: Dns.LookupAddress[]) => void
    ) => {
      dns.asked.push(hostname);
      callback(null, dns.answer);
    },
  };
});

interface SiteAnswer {
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string>>;
}

/** The sites' answers as they come off the wire; with none, requests are real. */
const site = vi.hoisted(() => ({
  answers: new Array<SiteAnswer>(),
}));

vi.mock("node:https", async (importOriginal) => {
  const original = await importOriginal<typeof Https>();
  return {
    ...original,
    request: (
      url: URL,
      options: Https.RequestOptions,
      callback: (response: Readable) => void
    ) => {
      const answer = site.answers.shift();
      if (answer === undefined) return original.request(url, options, callback);
      const outgoing = Object.assign(new EventEmitter(), {
        destroy: () => undefined,
        end: () => {
          const response = Object.assign(Readable.from([answer.body]), {
            headers: Object.fromEntries(
              Object.entries(answer.headers).map(([name, value]) => [
                name.toLowerCase(),
                value,
              ])
            ),
            rawHeaders: Object.entries(answer.headers).flat(),
            statusCode: 200,
          });
          setImmediate(() => {
            callback(response);
          });
        },
      });
      return outgoing;
    },
  };
});

afterEach(() => {
  clearSandboxSettings();
  vi.unstubAllGlobals();
  site.answers = [];
  dns.answer = [];
  dns.asked = [];
  vi.resetModules();
});

describe("a request the sandbox tool router makes", () => {
  it("tells public addresses from the network's own", async () => {
    const { isPublicAddress } = await import("@agent/lib/sandbox/public-fetch");
    for (const address of [
      "10.1.2.3",
      "100.100.100.200",
      "127.0.0.1",
      "169.254.169.254",
      "172.20.0.1",
      "192.168.1.1",
      "0.0.0.0",
      "::1",
      "::",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "fd00:ec2::254",
      "fe80::1",
      "not an address",
    ]) {
      expect({ address, public: isPublicAddress(address) }).toEqual({
        address,
        public: false,
      });
    }
    for (const address of ["93.184.215.14", "2a00:1450:4010:c05::64"]) {
      expect({ address, public: isPublicAddress(address) }).toEqual({
        address,
        public: true,
      });
    }
  });

  it("refuses a public-looking name that resolves inside, before connecting", async () => {
    const { fetchPublic } = await import("@agent/lib/sandbox/public-fetch");
    dns.answer = [{ address: "10.0.0.5", family: 4 }];
    await expect(
      fetchPublic(new URL("https://intranet.example.test/admin"))
    ).rejects.toMatchObject({ name: "BlockedHostError" });
    // One private address among public ones is enough to refuse the name:
    // the connection may pick any of them.
    dns.answer = [
      { address: "93.184.215.14", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ];
    await expect(
      fetchPublic(new URL("https://metadata.example.test/"))
    ).rejects.toMatchObject({ name: "BlockedHostError" });
    // An address written in the link is never looked up: checked as is.
    for (const literal of ["https://127.0.0.1/", "https://[::1]/"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One link at a time.
      await expect(fetchPublic(new URL(literal))).rejects.toMatchObject({
        name: "BlockedHostError",
      });
    }
    expect(dns.asked).toEqual([
      "intranet.example.test",
      "metadata.example.test",
    ]);
  });

  it("answers web_fetch and download for such a name with a blocked host", async () => {
    dns.answer = [{ address: "127.0.0.1", family: 4 }];
    // Object Storage has no mark of the person's files for this sandbox.
    vi.stubGlobal("fetch", async (url: string) => {
      if (!url.includes("/sandbox/person-files/")) {
        throw new Error("Only the mark is asked of Object Storage here.");
      }
      return await Promise.resolve(
        new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
      );
    });
    const ask = await importWithSandbox(async () => {
      const [{ answerSandboxToolRequest }, keys] = await Promise.all([
        import("@agent/lib/sandbox/router"),
        import("@agent/lib/sandbox/keys"),
      ]);
      const token = keys.signSandboxToolsToken({
        sandboxId: "sb-1",
        workspaceId: "personal:abc",
      });
      return async (name: string) => {
        const response = await answerSandboxToolRequest(
          new Request("https://bro.example.test/eve/v1/sandbox-tools", {
            body: JSON.stringify({
              query:
                "mutation($name: String!, $input: JSON!) { toolExecute(name: $name, input: $input) { ok error } }",
              variables: {
                input: { url: "https://rebind.example.test/" },
                name,
              },
            }),
            headers: { authorization: `Bearer ${token}` },
            method: "POST",
          })
        );
        return z
          .object({
            data: z.object({
              toolExecute: z.object({ error: z.string(), ok: z.boolean() }),
            }),
          })
          .parse(await response.json()).data.toolExecute;
      };
    });
    expect(await ask("web_fetch")).toEqual({
      error: "The page did not open: blocked-host.",
      ok: false,
    });
    expect(await ask("download")).toEqual({
      error: "The file did not download: blocked-host.",
      ok: false,
    });
  });

  it("undoes stacked content codings in reverse order", async () => {
    const { fetchPublic } = await import("@agent/lib/sandbox/public-fetch");
    const page = "<p>Привет</p>";
    site.answers.push({
      // Brotli first, then gzip: the header lists them as applied.
      body: gzipSync(brotliCompressSync(Buffer.from(page))),
      headers: {
        "Content-Encoding": "br, gzip",
        "Content-Length": "999",
        "Content-Type": "text/html",
      },
    });
    const response = await fetchPublic(new URL("https://site.example.test/"));
    expect(await response.text()).toBe(page);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    site.answers.push({
      body: gzipSync(deflateSync(Buffer.from(page))),
      headers: { "Content-Encoding": "Deflate, identity , X-Gzip" },
    });
    const again = await fetchPublic(new URL("https://site.example.test/"));
    expect(await again.text()).toBe(page);
  });

  it("fails a coding it cannot undo, and bounds the decoded size", async () => {
    const [{ fetchPublic }, { downloadWithin }] = await Promise.all([
      import("@agent/lib/sandbox/public-fetch"),
      import("@agent/lib/inbound-media/download"),
    ]);
    site.answers.push({
      body: gzipSync(Buffer.from("text")),
      headers: { "Content-Encoding": "gzip, compress" },
    });
    await expect(
      downloadWithin(new URL("https://site.example.test/"), 1000, {
        fetch: fetchPublic,
      })
    ).resolves.toEqual({ kind: "failed", reason: "network" });
    // Each coding is a decoder of its own: a long chain is refused unread,
    // even one that would unpack.
    site.answers.push({
      body: Array.from({ length: 6 }).reduce<Buffer>(
        (packed) => gzipSync(packed),
        Buffer.from("text")
      ),
      headers: { "Content-Encoding": Array(6).fill("gzip").join(", ") },
    });
    await expect(
      downloadWithin(new URL("https://site.example.test/"), 1000, {
        fetch: fetchPublic,
      })
    ).resolves.toEqual({ kind: "failed", reason: "network" });
    // A megabyte of zeros packs into a kilobyte: the cap is on what unpacks.
    site.answers.push({
      body: gzipSync(gzipSync(Buffer.alloc(1024 * 1024))),
      headers: { "Content-Encoding": "gzip, gzip" },
    });
    await expect(
      downloadWithin(new URL("https://site.example.test/"), 64 * 1024, {
        fetch: fetchPublic,
      })
    ).resolves.toEqual({ kind: "oversize" });
  });
});
