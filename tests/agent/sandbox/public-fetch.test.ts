import type * as Dns from "node:dns";
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

afterEach(() => {
  clearSandboxSettings();
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
});
