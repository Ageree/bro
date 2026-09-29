import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  browserVmTestEnvironment,
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";

const workspaceId = "personal:0123456789abcdef0123456789abcdef";
const vm = { generation: 4, host: "45.132.176.116", workspaceId };
const origin = "https://45-132-176-116.sslip.io";
const sessionId = `vm:${workspaceId}:s:5e7d2c1a-8b9f-4e3d-a2c1-0f9e8d7c6b5a`;
const runId = `vm:${workspaceId}:r:1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d`;
const nowSeconds = 1_790_000_000;
const llm = {
  apiKey: "routerai-test-key",
  baseUrl: "https://routerai.ru/api/v1",
  model: "deepseek/deepseek-v4.1-flash",
};

const claimsSchema = z.object({
  env: z.string(),
  exp: z.number(),
  gen: z.number(),
  ses: z.string().optional(),
});

afterEach(() => {
  clearBrowserVmSettings();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

interface Call {
  readonly body: string;
  readonly headers: Headers;
  readonly method: string;
  readonly url: string;
}

function stubWorker(...answers: readonly Response[]) {
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

async function loadWorker() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(nowSeconds * 1_000);
  return importWithSettings(browserVmTestEnvironment, async () => ({
    token: await import("@agent/lib/browser-vm/token"),
    worker: await import("@agent/lib/browser-vm/worker"),
  }));
}

/**
 * What the worker would read in a token: its claims, once the signature
 * checks out against this VM's key.
 */
function verifiedClaims(key: Buffer, token: string) {
  const [version, payload, signature] = token.split(".");
  const expected = createHmac("sha256", key)
    .update(`${version ?? ""}.${payload ?? ""}`)
    .digest("base64url");
  expect(version).toBe("v1");
  expect(signature).toBe(expected);
  return claimsSchema.parse(
    JSON.parse(Buffer.from(payload ?? "", "base64url").toString())
  );
}

/** A run as the worker's `Run.public()` writes it. */
function workerRun(
  overrides: { readonly error?: string; readonly status?: string } = {}
) {
  return {
    createdAt: "2026-09-28T10:00:00Z",
    engine: "agent",
    error: null,
    finalTitle: "Корзина",
    finalUrl: "https://www.wildberries.ru/lk/basket",
    finishedAt: "2026-09-28T10:04:00Z",
    id: runId,
    jev: null,
    result: "ITEMS: 1",
    sessionId,
    startedAt: "2026-09-28T10:00:01Z",
    status: "completed",
    stepCount: 12,
    steps: [
      {
        actions: [
          { action: "click", index: 14 },
          { action: "done", index: null },
        ],
        at: "2026-09-28T10:03:59Z",
        goal: "Report the basket",
        number: 12,
        title: "Корзина",
        url: "https://www.wildberries.ru/lk/basket",
      },
    ],
    success: true,
    task: "Найди чайник\nBro errand: e1",
    usage: { total_cost: 0.0042, total_tokens: 51_234 },
    ...overrides,
  };
}

describe("browser VM worker client", () => {
  it("checks health without a token, at the sslip.io name of the address", async () => {
    const { worker } = await loadWorker();
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    const calls = stubWorker(
      Response.json({
        busy: false,
        chrome: true,
        configured: true,
        generation: 4,
        image: "bro-browser-2026-09-28-1",
        proxy: false,
        stage: "ready",
        uptimeSeconds: 48.2,
        worker: "2026-09-28.1",
      })
    );

    const health = await worker.readBrowserVmWorkerHealth(vm);

    expect(health).toMatchObject({
      chrome: true,
      configured: true,
      proxy: false,
    });
    expect(calls[0]?.url).toBe(`${origin}/v1/health`);
    expect(calls[0]?.headers.get("authorization")).toBeNull();
    expect(timeouts).toHaveBeenCalledWith(5_000);
  });

  it("signs every other call for this VM and its generation", async () => {
    const { token, worker } = await loadWorker();
    const calls = stubWorker(
      Response.json({ id: runId, sessionId, status: "queued" }, { status: 202 })
    );

    const started = await worker.startBrowserVmWorkerRun(vm, {
      id: runId,
      llm,
      maxSteps: 60,
      secrets: [
        {
          alias: "login_phone",
          allowedDomains: ["wildberries.ru"],
          value: "9161234567",
        },
      ],
      sessionId,
      task: "Найди чайник\nBro errand: e1",
      timeoutSeconds: 1_500,
    });

    expect(started).toEqual({ id: runId, sessionId, status: "queued" });
    const [call] = calls;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(`${origin}/v1/runs`);
    const bearer = call?.headers.get("authorization") ?? "";
    expect(bearer.startsWith("Bearer v1.")).toBe(true);
    expect(
      verifiedClaims(token.browserVmKey(workspaceId), bearer.slice(7))
    ).toEqual({ env: workspaceId, exp: nowSeconds + 300, gen: 4 });
    expect(JSON.parse(call?.body ?? "")).toEqual({
      id: runId,
      llm,
      maxSteps: 60,
      secrets: [
        {
          alias: "login_phone",
          allowedDomains: ["wildberries.ru"],
          value: "9161234567",
        },
      ],
      sessionId,
      task: "Найди чайник\nBro errand: e1",
      timeoutSeconds: 1_500,
    });
  });

  it("names the run that holds the browser when a start is refused as busy", async () => {
    const { worker } = await loadWorker();
    stubWorker(
      Response.json({ error: "busy", runId: "vm:other:r:1" }, { status: 409 }),
      Response.json({ error: "task is required" }, { status: 400 })
    );
    const input = { id: runId, llm, task: "t" };

    await expect(
      worker.startBrowserVmWorkerRun(vm, input)
    ).rejects.toMatchObject({
      busyRunId: "vm:other:r:1",
      name: "BrowserVmWorkerError",
      status: 409,
    });
    await expect(
      worker.startBrowserVmWorkerRun(vm, input)
    ).rejects.toMatchObject({ busyRunId: undefined, status: 400 });
  });

  it("reads a run with its steps, and one the worker never had as missing", async () => {
    const { worker } = await loadWorker();
    const calls = stubWorker(
      Response.json({
        ...workerRun(),
        unreadMessages: ["Add the blue one too"],
      }),
      Response.json({ error: "no such run" }, { status: 404 })
    );

    const run = await worker.readBrowserVmWorkerRun(vm, runId);

    expect(run).toMatchObject({
      finalUrl: "https://www.wildberries.ru/lk/basket",
      result: "ITEMS: 1",
      status: "completed",
      stepCount: 12,
      // Messages the run never read before it settled: the worker never
      // starts a follow-up of its own to answer them.
      unreadMessages: ["Add the blue one too"],
    });
    expect(await worker.readBrowserVmWorkerRun(vm, runId)).toBeUndefined();
    expect(calls[0]?.url).toBe(
      `${origin}/v1/runs/${encodeURIComponent(runId)}`
    );
  });

  it("reads a run with no unread messages, from a worker that omits the field", async () => {
    const { worker } = await loadWorker();
    stubWorker(Response.json(workerRun()));

    const run = await worker.readBrowserVmWorkerRun(vm, runId);

    expect(run?.unreadMessages).toBeUndefined();
  });

  it("finds runs by a line of their task and cancels one", async () => {
    const { worker } = await loadWorker();
    const { steps: _steps, ...summary } = workerRun({ status: "running" });
    const calls = stubWorker(
      Response.json({ runs: [summary] }),
      Response.json(
        workerRun({ error: "Stopped by Bro.", status: "cancelled" })
      )
    );

    const found = await worker.listBrowserVmWorkerRuns(vm, "Bro errand: e1");
    const cancelled = await worker.cancelBrowserVmWorkerRun(vm, runId);

    expect(found.map((run) => run.id)).toEqual([runId]);
    expect(cancelled.status).toBe("cancelled");
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${origin}/v1/runs?contains=Bro+errand%3A+e1`],
      ["POST", `${origin}/v1/runs/${encodeURIComponent(runId)}/cancel`],
    ]);
  });

  it("reads a session, sends it a message with the model and releases its tab", async () => {
    const { worker } = await loadWorker();
    const followUp = `vm:${workspaceId}:r:9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a`;
    const calls = stubWorker(
      Response.json({
        id: sessionId,
        latestRunId: runId,
        status: "idle",
        tabOpen: true,
      }),
      Response.json({ runId: followUp, sessionId, status: "started" }),
      Response.json({ status: "stopped" }),
      Response.json({ error: "no such session" }, { status: 404 })
    );

    const session = await worker.readBrowserVmWorkerSession(vm, sessionId);
    const message = await worker.sendBrowserVmWorkerMessage(vm, sessionId, {
      llm,
      runId: followUp,
      text: "123456",
    });
    const released = await worker.releaseBrowserVmWorkerSession(vm, sessionId);

    expect(session).toEqual({
      id: sessionId,
      latestRunId: runId,
      status: "idle",
      tabOpen: true,
    });
    expect(message).toEqual({ runId: followUp, sessionId, status: "started" });
    expect(released).toBe("stopped");
    expect(
      await worker.readBrowserVmWorkerSession(vm, sessionId)
    ).toBeUndefined();
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}`;
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${origin}${path}`],
      ["POST", `${origin}${path}/messages`],
      ["POST", `${origin}${path}/release`],
      ["GET", `${origin}${path}`],
    ]);
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({
      llm,
      runId: followUp,
      text: "123456",
    });
  });

  it("sets the proxy and reads where it exits, or why it could not tell", async () => {
    const { worker } = await loadWorker();
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    const traffic = { connections: 3, down: 1_024, refused: 0, up: 512 };
    const calls = stubWorker(
      Response.json({
        chrome: true,
        exit: {
          city: "Moscow",
          country: "RU",
          ip: "5.18.0.1",
          org: "AS12389 Rostelecom",
          region: "Moscow",
        },
        traffic,
        vmAddress: "45.132.176.116",
      }),
      Response.json({
        chrome: true,
        exit: { error: "ClientProxyConnectionError: refused" },
        traffic,
        vmAddress: null,
      }),
      // The megabyte did not come through; the address still did.
      Response.json({
        chrome: true,
        exit: {
          country: "RU",
          ip: "5.18.0.2",
          latencyMs: 640,
          speedError: "TimeoutError: ",
        },
        traffic,
        vmAddress: "45.132.176.116",
      }),
      // An older worker wrote that failure as `error`, next to the address.
      Response.json({
        chrome: true,
        exit: { country: "RU", error: "TimeoutError: ", ip: "5.18.0.3" },
        traffic,
        vmAddress: "45.132.176.116",
      })
    );
    const proxy = {
      host: "proxy.example.test",
      password: "pa:ss",
      port: 9000,
      username: "user-session-bro1",
    };

    const first = await worker.setBrowserVmWorkerProxy(vm, proxy);
    const second = await worker.setBrowserVmWorkerProxy(vm, proxy);
    const third = await worker.setBrowserVmWorkerProxy(vm, proxy);
    const fourth = await worker.setBrowserVmWorkerProxy(vm, proxy);

    expect(first.exit).toMatchObject({ country: "RU", ip: "5.18.0.1" });
    expect(second.exit).toEqual({
      error: "ClientProxyConnectionError: refused",
    });
    expect(third.exit).toEqual({
      country: "RU",
      ip: "5.18.0.2",
      latencyMs: 640,
      speedError: "TimeoutError: ",
    });
    expect(fourth.exit).toMatchObject({ country: "RU", ip: "5.18.0.3" });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ proxy });
    expect(calls[0]?.url).toBe(`${origin}/v1/session`);
    expect(timeouts).toHaveBeenCalledWith(60_000);
  });

  it("lists a session's files and builds a download URL scoped to that session", async () => {
    const { token, worker } = await loadWorker();
    const calls = stubWorker(
      Response.json({
        files: [
          {
            lastModified: "2026-09-28T10:04:00Z",
            path: "report/red kettle.jpg",
            size: 20_480,
          },
        ],
      })
    );

    const files = await worker.listBrowserVmWorkerFiles(
      vm,
      sessionId,
      "report/"
    );
    const url = new URL(
      worker.browserVmFileUrl(vm, sessionId, "report/red kettle.jpg")
    );

    expect(files).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${origin}/v1/files?prefix=report%2F&session=${encodeURIComponent(sessionId)}`
    );
    const [, , , fileToken, session, ...path] = url.pathname.split("/");
    expect(url.origin).toBe(origin);
    expect(url.pathname.startsWith("/v1/dl/")).toBe(true);
    expect(decodeURIComponent(session ?? "")).toBe(sessionId);
    expect(path).toEqual(["report", "red%20kettle.jpg"]);
    expect(
      verifiedClaims(token.browserVmKey(workspaceId), fileToken ?? "")
    ).toEqual({
      env: workspaceId,
      exp: nowSeconds + 120,
      gen: 4,
      ses: sessionId,
    });
  });

  it("hands out a CDP endpoint scoped to an errand's session or a keep-alive tab", async () => {
    const { token, worker } = await loadWorker();
    const key = token.browserVmKey(workspaceId);

    const errand = worker.browserVmCdpUrl(vm, { sessionId });
    const keepAlive = worker.browserVmCdpUrl(vm, { targetId: "9A1F0C3B2E" });

    const prefix = "wss://45-132-176-116.sslip.io/v1/cdp/";
    expect(errand.startsWith(prefix)).toBe(true);
    expect(verifiedClaims(key, errand.slice(prefix.length))).toEqual({
      env: workspaceId,
      exp: nowSeconds + 300,
      gen: 4,
      ses: sessionId,
    });
    expect(verifiedClaims(key, keepAlive.slice(prefix.length)).ses).toBe(
      "b:9A1F0C3B2E"
    );
  });

  it("opens and closes a keep-alive tab, and controls Chrome and its profile", async () => {
    const { worker } = await loadWorker();
    const calls = stubWorker(
      Response.json({ targetId: "9A1F0C3B2E" }),
      Response.json({ closed: "9A1F0C3B2E" }),
      Response.json({ chrome: false, output: "", rc: 0 }),
      Response.json({ chrome: true, reset: true })
    );

    expect(await worker.openBrowserVmWorkerTab(vm)).toBe("9A1F0C3B2E");
    await worker.closeBrowserVmWorkerTab(vm, "9A1F0C3B2E");
    expect(await worker.controlBrowserVmWorkerChrome(vm, "stop")).toEqual({
      chrome: false,
      output: "",
      rc: 0,
    });
    expect(await worker.resetBrowserVmWorkerProfile(vm)).toEqual({
      chrome: true,
      reset: true,
    });
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", `${origin}/v1/tabs`],
      ["DELETE", `${origin}/v1/tabs/9A1F0C3B2E`],
      ["POST", `${origin}/v1/browser/stop`],
      ["POST", `${origin}/v1/profile/reset`],
    ]);
  });

  it("calls nothing for a VM whose address is not known yet", async () => {
    const { worker } = await loadWorker();
    const calls = stubWorker();

    await expect(
      worker.readBrowserVmWorkerHealth({ ...vm, host: null })
    ).rejects.toThrow("no public IPv4 address");
    expect(calls).toEqual([]);
  });

  it("treats an answer that is not the contract as a failure", async () => {
    const { worker } = await loadWorker();
    stubWorker(
      new Response("<html>Caddy</html>", { status: 200 }),
      new Response("bad gateway", { status: 502 })
    );

    await expect(
      worker.readBrowserVmWorkerRun(vm, runId)
    ).rejects.toMatchObject({
      status: 200,
    });
    await expect(
      worker.readBrowserVmWorkerRun(vm, runId)
    ).rejects.toMatchObject({
      name: "BrowserVmWorkerError",
      status: 502,
    });
  });
});
