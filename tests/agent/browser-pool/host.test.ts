import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  browserPoolTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

const workspaceId = "personal:0123456789abcdef0123456789abcdef";
const sandboxId = "ws-1e09f74980c731c7119e14ac3afe57dbe608baba";
const host = { address: "45.132.176.117", id: "bro-host-1" };
const origin = "https://45-132-176-117.sslip.io";
const nowSeconds = 1_790_769_600;

afterEach(() => {
  clearBrowserVmSettings();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

interface Call {
  readonly body: string;
  readonly headers: Headers;
  readonly method: string;
  readonly url: string;
}

function stubHost(...answers: readonly Response[]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    (
      url: string,
      init: { body?: string; headers: HeadersInit; method: string }
    ) => {
      calls.push({
        body: init.body ?? "",
        headers: new Headers(init.headers),
        method: init.method,
        url,
      });
      const answer = answers[calls.length - 1];
      if (!answer) throw new Error("The test ran out of stubbed answers.");
      return Promise.resolve(answer);
    }
  );
  return calls;
}

async function loadHost(settings = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(nowSeconds * 1_000);
  return importWithSettings(
    { ...browserPoolTestEnvironment, ...settings },
    async () => import("@agent/lib/browser-pool/host")
  );
}

const sandbox = {
  generation: 5,
  id: sandboxId,
  memoryMb: 3072,
  path: "fresh",
  rootfsVersion: "2026-09-30.1",
  route: `/g/${sandboxId}/`,
  startedAt: "2026-09-30T12:00:00Z",
  state: "running",
  timings: { startMs: 900 },
  workspace: workspaceId,
};

const startBodySchema = z.object({
  generation: z.number(),
  id: z.string(),
  memoryMb: z.number(),
  profile: z.unknown().optional(),
  restore: z
    .object({
      chunkUrls: z.array(z.string()),
      dataKey: z.string(),
      manifestUrl: z.string(),
    })
    .optional(),
  rootfsVersion: z.string(),
  workerKey: z.string(),
  workspace: z.string(),
});

const parkBodySchema = z.object({
  dataKey: z.string(),
  generation: z.number(),
  upload: z.object({
    chunkUrls: z.array(z.string()),
    manifestUrl: z.string(),
  }),
});

describe("browser host client", () => {
  // `test_accepts_the_token_bro_signs` in browser-vm/host/test_hostd.py
  // verifies this very token: change the format in both.
  it("signs the token hostd verifies, byte for byte", async () => {
    const client = await loadHost();

    expect(client.signBrowserHostToken("host-test-1")).toBe(
      "v1.eyJlbnYiOiJob3N0LXRlc3QtMSIsImV4cCI6MTc5MDc2OTkwMH0.-933HCb8scg6e_0zBfRArnwAYAZoM8moZnOj8v0zwbA"
    );
    expect(() => client.signBrowserHostToken("host-test-1", 901)).toThrow(
      "lives 1 to 900"
    );
  });

  it("reaches hostd under /h/ and a sandbox's worker under /g/<id>", async () => {
    const client = await loadHost();

    expect(client.browserHostOrigin(host)).toBe(origin);
    expect(client.browserSandboxWorkerOrigin(host, workspaceId)).toBe(
      `${origin}/g/${sandboxId}`
    );
    expect(() =>
      client.browserHostOrigin({ address: null, id: "bro-host-1" })
    ).toThrow("no public IPv4");
    expect(client.browserStateSetKey(workspaceId, 7)).toBe(
      `sets/${sandboxId}/7/`
    );
  });

  it("reads health unsigned and capacity with a host token", async () => {
    const client = await loadHost();
    const calls = stubHost(
      Response.json({
        configured: true,
        hostd: "2026-09-30.1",
        runsc: null,
        stage: "rootfs",
      }),
      Response.json({
        cpu: { features: "abc", model: "Intel" },
        disk: { freeMb: 30_000, totalMb: 40_000 },
        host: "bro-host-1",
        memoryMb: { available: 12_000, committed: 3072, total: 16_000 },
        rootfsVersions: ["2026-09-30.1"],
        runsc: "runsc version release-20260914.0",
        sandboxes: [
          {
            generation: 5,
            id: sandboxId,
            memoryMb: 3072,
            state: "running",
            usedMb: 2400,
          },
        ],
        shm: { freeMb: 8000, totalMb: 8000 },
        snapshotFormat: {
          cpu: "abc",
          runsc: "runsc version release-20260914.0",
        },
      })
    );

    expect((await client.readBrowserHostHealth(host)).stage).toBe("rootfs");
    expect(
      (await client.readBrowserHostCapacity(host)).memoryMb?.committed
    ).toBe(3072);
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${origin}/h/v1/health`],
      ["GET", `${origin}/h/v1/capacity`],
    ]);
    expect(calls[0]?.headers.has("authorization")).toBe(false);
    expect(calls[1]?.headers.get("authorization")).toBe(
      `Bearer ${client.signBrowserHostToken("bro-host-1")}`
    );
  });

  it("starts a fresh sandbox with the workspace's worker key and root", async () => {
    const client = await loadHost();
    const calls = stubHost(Response.json(sandbox, { status: 201 }));
    const token = await import("@agent/lib/browser-vm/token");

    expect(
      await client.startBrowserSandbox(host, { generation: 5, workspaceId })
    ).toMatchObject({ path: "fresh", state: "running" });
    const body = startBodySchema.parse(JSON.parse(calls[0]?.body ?? ""));
    expect(calls[0]?.url).toBe(`${origin}/h/v1/sandboxes`);
    expect(body).toEqual({
      generation: 5,
      id: sandboxId,
      memoryMb: 3072,
      rootfsVersion: "2026-09-30.1",
      workerKey: token.browserVmKey(workspaceId).toString("hex"),
      workspace: workspaceId,
    });
  });

  it("restores from a set with GET URLs for its chunks, or cold from its profile", async () => {
    const client = await loadHost();
    const keys = await import("@agent/lib/browser-pool/keys");
    const calls = stubHost(
      Response.json(sandbox, { status: 201 }),
      Response.json(sandbox, { status: 201 })
    );
    const set = { chunks: 3, key: `sets/${sandboxId}/4/` };

    await client.startBrowserSandbox(host, {
      from: { ...set, snapshot: true },
      generation: 5,
      workspaceId,
    });
    await client.startBrowserSandbox(host, {
      from: { ...set, snapshot: false },
      generation: 5,
      workspaceId,
    });
    const restored = startBodySchema.parse(JSON.parse(calls[0]?.body ?? ""));
    const cold = startBodySchema.parse(JSON.parse(calls[1]?.body ?? ""));
    expect(restored.profile).toBeUndefined();
    expect(cold.restore).toBeUndefined();
    expect(cold.profile).toEqual(restored.restore);
    const source = restored.restore;
    expect(source?.dataKey).toBe(keys.browserStateDataKey(workspaceId));
    expect(source?.chunkUrls.map((url) => new URL(url).pathname)).toEqual([
      `/bro-state-test/sets/${sandboxId}/4/chunk-0000`,
      `/bro-state-test/sets/${sandboxId}/4/chunk-0001`,
      `/bro-state-test/sets/${sandboxId}/4/chunk-0002`,
    ]);
    expect(new URL(source?.manifestUrl ?? "").pathname).toBe(
      `/bro-state-test/sets/${sandboxId}/4/manifest.json`
    );
    expect(
      new URL(source?.manifestUrl ?? "").searchParams.get("X-Amz-Expires")
    ).toBe("1800");
  });

  it("parks into a new set with PUT URLs enough for the whole sandbox", async () => {
    const client = await loadHost();
    const calls = stubHost(
      Response.json({
        chunks: 42,
        format: {
          cpu: "abc",
          memoryMb: 3072,
          rootfs: "2026-09-30.1",
          runsc: "r",
        },
        generation: 6,
        id: sandboxId,
        parts: {
          image: { bytes: 600_000_000, chunks: 36, plainBytes: 2_500_000_000 },
          profile: { bytes: 90_000_000, chunks: 6, plainBytes: 180_000_000 },
        },
        state: "parked",
        timings: { checkpointMs: 900, totalMs: 9000 },
      })
    );

    const parked = await client.parkBrowserSandbox(host, {
      generation: 6,
      workspaceId,
    });
    expect(parked).toMatchObject({ chunks: 42, key: `sets/${sandboxId}/6/` });
    expect(calls[0]?.url).toBe(`${origin}/h/v1/sandboxes/${sandboxId}/park`);
    const body = parkBodySchema.parse(JSON.parse(calls[0]?.body ?? ""));
    expect(body.generation).toBe(6);
    // (3072 + 2048) MB with 2% to spare, in 16 MB chunks, and one per part.
    expect(body.upload.chunkUrls).toHaveLength(329);
    expect(new URL(body.upload.chunkUrls[328] ?? "").pathname).toBe(
      `/bro-state-test/sets/${sandboxId}/6/chunk-0328`
    );
    expect(
      new URL(body.upload.chunkUrls[0] ?? "").searchParams.get("X-Amz-Expires")
    ).toBe("3600");
  });

  it("reads and deletes a sandbox, and tells a missing one apart", async () => {
    const client = await loadHost();
    const calls = stubHost(
      Response.json({ error: "no such sandbox" }, { status: 404 }),
      Response.json({ error: "no such sandbox" }, { status: 404 }),
      Response.json({ deleted: true, id: sandboxId }),
      Response.json(
        { error: "stale generation", generation: 7 },
        { status: 409 }
      )
    );

    expect(await client.readBrowserSandbox(host, workspaceId)).toBeUndefined();
    expect(
      await client.deleteBrowserSandbox(host, { generation: 5, workspaceId })
    ).toBe(false);
    expect(
      await client.deleteBrowserSandbox(host, { generation: 5, workspaceId })
    ).toBe(true);
    const refused = client.deleteBrowserSandbox(host, {
      generation: 5,
      workspaceId,
    });
    await expect(refused).rejects.toBeInstanceOf(client.BrowserHostError);
    await expect(refused).rejects.toMatchObject({ status: 409 });
    expect(calls[1]?.url).toBe(
      `${origin}/h/v1/sandboxes/${sandboxId}?generation=5`
    );
    expect(calls[1]?.method).toBe("DELETE");
  });
});
