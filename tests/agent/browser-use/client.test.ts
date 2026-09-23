import { afterEach, describe, expect, it, vi } from "vitest";

const baseUrl = "https://browser-use.test/api/v4";
const runId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  // Clearing every stub would also drop the values tests/setup-env.ts installs.
  vi.stubEnv("BROWSER_USE_API_KEY", "");
  vi.stubEnv("BROWSER_USE_BASE_URL", "");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.useRealTimers();
});

async function loadClient() {
  vi.resetModules();
  // A newline in the middle of the stored key is what a paste into a hosted
  // environment leaves behind, and `fetch` rejects such a header value.
  vi.stubEnv("BROWSER_USE_API_KEY", "  browser\nuse-key ");
  vi.stubEnv("BROWSER_USE_BASE_URL", baseUrl);
  return import("@agent/lib/browser-use/client");
}

interface StubbedCall {
  readonly body: string;
  readonly headers: Headers;
  readonly method: string;
  readonly signal: AbortSignal | null | undefined;
  readonly url: string;
}

function stubFetch(...responses: readonly Response[]) {
  const calls: StubbedCall[] = [];
  let index = 0;
  // The client always calls fetch with a URL and its own plain init object.
  vi.stubGlobal(
    "fetch",
    (
      url: URL,
      init: {
        body?: string;
        headers: HeadersInit;
        method: string;
        signal?: AbortSignal | null;
      }
    ) => {
      calls.push({
        body: init.body ?? "",
        headers: new Headers(init.headers),
        method: init.method,
        signal: init.signal,
        url: url.toString(),
      });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (!response) throw new Error("The test ran out of stubbed responses.");
      return Promise.resolve(response.clone());
    }
  );
  return calls;
}

function recoverySummary(index: number, owner = sessionId) {
  return {
    id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    sessionId: owner,
    status: "completed",
    task: `Recovery marker ${String(index)}`,
  };
}

describe("Browser Use client", () => {
  it("creates a run with the v4 field names and a whitespace-free key", async () => {
    const client = await loadClient();
    const calls = stubFetch(
      Response.json({
        eventsUrl: `${baseUrl}/runs/${runId}/events`,
        id: runId,
        model: "hosted-agent",
        sessionId,
        status: "running",
        workspaceId: "33333333-3333-4333-8333-333333333333",
      })
    );

    const run = await client.createBrowserUseRun({
      maxCostUsd: 2.5,
      model: "hosted-agent",
      profileId: "profile-1",
      proxyCountryCode: "ru",
      secretBindings: [
        {
          allowedDomains: ["example.com"],
          alias: "login_password",
          source: { type: "inline", value: "hunter2" },
        },
      ],
      task: "Order the usual",
    });

    expect(run.id).toBe(runId);
    expect(run.sessionId).toBe(sessionId);
    const [call] = calls;
    expect(call?.url).toBe(`${baseUrl}/runs`);
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("x-browser-use-api-key")).toBe("browseruse-key");
    expect(JSON.parse(call?.body ?? "")).toEqual({
      browserSettings: { profileId: "profile-1", proxyCountryCode: "ru" },
      maxCostUsd: 2.5,
      model: "hosted-agent",
      secretBindings: [
        {
          allowedDomains: ["example.com"],
          alias: "login_password",
          source: { type: "inline", value: "hunter2" },
        },
      ],
      task: "Order the usual",
    });
  });

  it("retries a server error once and reports the status with a body excerpt", async () => {
    const client = await loadClient();
    const calls = stubFetch(
      new Response("upstream exploded", { status: 503 }),
      new Response("upstream exploded", { status: 503 })
    );

    const failure = await client
      .readBrowserUseRunStatus(runId)
      .catch((cause: unknown) => cause);

    if (!(failure instanceof client.BrowserUseError)) {
      throw new Error("A failed Browser Use call must reject with its error.");
    }
    expect(failure.status).toBe(503);
    expect(failure.message).toContain("upstream exploded");
    expect(calls).toHaveLength(2);
  });

  it("briefly retries a newly accepted run that is not visible yet", async () => {
    vi.useFakeTimers();
    const client = await loadClient();
    const calls = stubFetch(
      new Response('{"detail":"run not found"}', { status: 404 }),
      Response.json({ status: "dispatching" })
    );

    const pending = client.readBrowserUseRunStatus(runId);
    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toBe("dispatching");
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("stops retrying a run id that stays missing after the grace window", async () => {
    vi.useFakeTimers();
    const client = await loadClient();
    const calls = stubFetch(
      new Response('{"detail":"run not found"}', { status: 404 })
    );

    const pending = client.readBrowserUseRunStatus(runId);
    await Promise.all([
      vi.runAllTimersAsync(),
      expect(pending).rejects.toMatchObject({ status: 404 }),
    ]);
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("does not start another GET when a slow 404 consumes the grace window", async () => {
    vi.useFakeTimers();
    const client = await loadClient();
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: URL, init: RequestInit) => {
      calls.push(`${init.method ?? "GET"} ${url.toString()}`);
      return new Promise<Response>((resolve) =>
        setTimeout(() => {
          resolve(new Response("not found", { status: 404 }));
        }, 2_900)
      );
    });

    const pending = client.readBrowserUseRunStatus(runId);
    await Promise.all([
      vi.runAllTimersAsync(),
      expect(pending).rejects.toMatchObject({ status: 404 }),
    ]);

    expect(calls).toEqual([`GET ${baseUrl}/runs/${runId}/status`]);
  });

  it("aborts a hung status GET at the overall grace deadline", async () => {
    vi.useFakeTimers();
    const client = await loadClient();
    const calls: string[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((delayMs) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new DOMException("timed out", "TimeoutError"));
      }, delayMs);
      return controller.signal;
    });
    vi.stubGlobal(
      "fetch",
      (url: URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          calls.push(`${init.method ?? "GET"} ${url.toString()}`);
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("timed out", "TimeoutError"));
          });
        })
    );

    const pending = client.readBrowserUseRunStatus(runId);
    await Promise.all([
      vi.advanceTimersByTimeAsync(3_000),
      expect(pending).rejects.toMatchObject({ name: "TimeoutError" }),
    ]);

    expect(calls).toEqual([`GET ${baseUrl}/runs/${runId}/status`]);
  });

  it("returns an already visible status without waiting or retrying", async () => {
    vi.useFakeTimers();
    const client = await loadClient();
    const calls = stubFetch(Response.json({ status: "running" }));

    await expect(client.readBrowserUseRunStatus(runId)).resolves.toBe(
      "running"
    );

    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403])(
    "does not apply visibility retries to a %s auth failure",
    async (status) => {
      vi.useFakeTimers();
      const client = await loadClient();
      const calls = stubFetch(new Response("unauthorized", { status }));

      await expect(client.readBrowserUseRunStatus(runId)).rejects.toMatchObject(
        { status }
      );

      expect(calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("does not apply visibility retries to a malformed success response", async () => {
    vi.useFakeTimers();
    const client = await loadClient();
    const calls = stubFetch(Response.json({ status: "unknown" }));

    await expect(client.readBrowserUseRunStatus(runId)).rejects.toBeInstanceOf(
      Error
    );

    expect(calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry run creation because the POST has no idempotency key", async () => {
    const client = await loadClient();
    const calls = stubFetch(new Response("upstream exploded", { status: 503 }));

    await expect(
      client.createBrowserUseRun({ task: "Do this once" })
    ).rejects.toThrow("upstream exploded");

    expect(calls).toHaveLength(1);
  });

  it("reads a run status, queues a session message and stops a session", async () => {
    const client = await loadClient();
    const calls = stubFetch(
      Response.json({ status: "completed" }),
      Response.json({ id: 7, sessionId, status: "pending" }),
      Response.json({
        items: [
          {
            agentSessionId: sessionId,
            id: "browser-active",
            status: "active",
          },
        ],
      }),
      Response.json({ id: "browser-active", status: "stopped" }),
      new Response(null, { status: 204 })
    );

    expect(await client.readBrowserUseRunStatus(runId)).toBe("completed");
    expect(
      (await client.queueBrowserUseSessionMessage(sessionId, "123456")).id
    ).toBe(7);
    await client.stopBrowserUseSession(sessionId);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${baseUrl}/runs/${runId}/status`,
      `POST ${baseUrl}/sessions/${sessionId}/queue`,
      `GET ${baseUrl}/browsers?agentSessionId=${sessionId}&filterBy=active&pageSize=100&pageNumber=1`,
      `PATCH ${baseUrl}/browsers/browser-active`,
      `DELETE ${baseUrl}/sessions/${sessionId}`,
    ]);
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({ text: "123456" });
    expect(JSON.parse(calls[3]?.body ?? "")).toEqual({ action: "stop" });
  });

  it("keeps the agent session when stopping its browser fails", async () => {
    const client = await loadClient();
    const calls = stubFetch(
      Response.json({
        items: [
          {
            agentSessionId: sessionId,
            id: "browser-active",
            status: "active",
          },
        ],
        pageNumber: 1,
        pageSize: 100,
        totalItems: 1,
      }),
      new Response("stop failed", { status: 503 }),
      new Response("stop failed", { status: 503 })
    );

    await expect(client.stopBrowserUseSession(sessionId)).rejects.toThrow(
      "stop failed"
    );

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${baseUrl}/browsers?agentSessionId=${sessionId}&filterBy=active&pageSize=100&pageNumber=1`,
      `PATCH ${baseUrl}/browsers/browser-active`,
      `PATCH ${baseUrl}/browsers/browser-active`,
    ]);
  });

  it("stops matching active browsers across every result page", async () => {
    const client = await loadClient();
    const calls = stubFetch(
      Response.json({
        items: [
          {
            agentSessionId: sessionId,
            id: "browser-first",
            status: "active",
          },
        ],
        pageNumber: 1,
        pageSize: 100,
        totalItems: 101,
      }),
      Response.json({
        items: [
          {
            agentSessionId: sessionId,
            id: "browser-last",
            status: "active",
          },
        ],
        pageNumber: 2,
        pageSize: 100,
        totalItems: 101,
      }),
      Response.json({ id: "browser-first", status: "stopped" }),
      Response.json({ id: "browser-last", status: "stopped" }),
      new Response(null, { status: 204 })
    );

    await client.stopBrowserUseSession(sessionId);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${baseUrl}/browsers?agentSessionId=${sessionId}&filterBy=active&pageSize=100&pageNumber=1`,
      `GET ${baseUrl}/browsers?agentSessionId=${sessionId}&filterBy=active&pageSize=100&pageNumber=2`,
      `PATCH ${baseUrl}/browsers/browser-first`,
      `PATCH ${baseUrl}/browsers/browser-last`,
      `DELETE ${baseUrl}/sessions/${sessionId}`,
    ]);
  });

  it("continues a full page when pagination metadata is absent", async () => {
    const client = await loadClient();
    const calls = stubFetch(
      Response.json({
        items: Array.from({ length: 100 }, (_, index) => ({
          agentSessionId:
            index === 0 ? sessionId : "99999999-9999-4999-8999-999999999999",
          id: `browser-${String(index)}`,
          status: "active",
        })),
      }),
      Response.json({ items: [] }),
      Response.json({ id: "browser-0", status: "stopped" }),
      new Response(null, { status: 204 })
    );

    await client.stopBrowserUseSession(sessionId);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${baseUrl}/browsers?agentSessionId=${sessionId}&filterBy=active&pageSize=100&pageNumber=1`,
      `GET ${baseUrl}/browsers?agentSessionId=${sessionId}&filterBy=active&pageSize=100&pageNumber=2`,
      `PATCH ${baseUrl}/browsers/browser-0`,
      `DELETE ${baseUrl}/sessions/${sessionId}`,
    ]);
  });

  it("deletes the agent session without touching unrelated or stopped browsers", async () => {
    const client = await loadClient();
    const calls = stubFetch(
      Response.json({
        items: [
          {
            agentSessionId: "99999999-9999-4999-8999-999999999999",
            id: "browser-unrelated",
            status: "active",
          },
          {
            agentSessionId: sessionId,
            id: "browser-stopped",
            status: "stopped",
          },
        ],
        pageNumber: 1,
        pageSize: 100,
        totalItems: 0,
      }),
      new Response(null, { status: 204 })
    );

    await client.stopBrowserUseSession(sessionId);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${baseUrl}/browsers?agentSessionId=${sessionId}&filterBy=active&pageSize=100&pageNumber=1`,
      `DELETE ${baseUrl}/sessions/${sessionId}`,
    ]);
  });

  it("takes the live view url from the browser.ready event", async () => {
    const client = await loadClient();
    const calls = stubFetch(
      Response.json({
        events: [
          { data: { model: "hosted-agent" }, id: 1, type: "run.started" },
          {
            data: { live_view_url: "https://live.browser-use.test/abc" },
            id: 2,
            type: "browser.ready",
          },
        ],
        hasMore: false,
        nextAfter: 2,
      })
    );

    const page = await client.listBrowserUseRunEvents(runId, 200, 42);
    expect(client.liveViewUrlFromEvents(page.events)).toBe(
      "https://live.browser-use.test/abc"
    );
    expect(client.liveViewUrlFromEvents([])).toBeUndefined();
    expect(calls[0]?.url).toBe(
      `${baseUrl}/runs/${runId}/events?limit=200&after=42`
    );
  });

  it("reads documented run cost and model metadata without making it required", async () => {
    const client = await loadClient();
    stubFetch(
      Response.json({
        error: null,
        id: runId,
        model: "hosted-agent",
        result: "RESULT: done\nNEEDS: none",
        sessionId,
        status: "completed",
        task: "Research",
        totalCostUsd: "0.42",
        totalInputTokens: 123,
        totalOutputTokens: 45,
      })
    );

    await expect(client.readBrowserUseRun(runId)).resolves.toMatchObject({
      model: "hosted-agent",
      totalCostUsd: "0.42",
      totalInputTokens: 123,
      totalOutputTokens: 45,
    });
  });

  it("lists at most fifty runs for one session across cursor pages", async () => {
    const client = await loadClient();
    const calls = stubFetch(
      Response.json({
        hasMore: true,
        nextCursor: "next page/+",
        runs: [
          ...Array.from({ length: 25 }, (_, index) => recoverySummary(index)),
          recoverySummary(99, "99999999-9999-4999-8999-999999999999"),
        ],
      }),
      Response.json({
        hasMore: true,
        nextCursor: "ignored",
        runs: Array.from({ length: 30 }, (_, index) =>
          recoverySummary(index + 25)
        ),
      })
    );

    const runs = await client.listBrowserUseRunsBySession(sessionId);

    expect(runs).toHaveLength(50);
    expect(runs[0]).toEqual({
      id: "00000000-1111-4111-8111-111111111111",
      sessionId,
      status: "completed",
      task: "Recovery marker 0",
    });
    expect(calls.map(({ url }) => url)).toEqual([
      `${baseUrl}/runs?sessionId=${sessionId}&limit=25`,
      `${baseUrl}/runs?sessionId=${sessionId}&limit=25&cursor=next+page%2F%2B`,
    ]);
  });

  it("finds the debugger endpoint of the browser this session is using", async () => {
    const client = await loadClient();
    const calls = stubFetch(
      Response.json({
        items: [
          {
            agentSessionId: "99999999-9999-4999-8999-999999999999",
            cdpUrl: "wss://cdp.browser-use.test/other",
            id: "browser-other",
            status: "active",
          },
          // The same session's earlier browser: it has no endpoint left to
          // type into, and taking it would send the code nowhere.
          {
            agentSessionId: sessionId,
            cdpUrl: null,
            id: "browser-stopped",
            status: "stopped",
          },
          {
            agentSessionId: sessionId,
            cdpUrl: "wss://cdp.browser-use.test/live",
            id: "browser-live",
            status: "active",
          },
        ],
      })
    );

    const controller = new AbortController();
    await expect(
      client.findBrowserUseSessionCdpUrl(sessionId, controller.signal)
    ).resolves.toBe("wss://cdp.browser-use.test/live");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.signal).toBe(controller.signal);
    expect(calls[0]?.url).toBe(
      `${baseUrl}/browsers?agentSessionId=${sessionId}&filterBy=active&pageSize=100&pageNumber=1`
    );
  });

  it("reports no endpoint when this session has no browser up", async () => {
    const client = await loadClient();
    stubFetch(Response.json({ items: [] }));
    await expect(
      client.findBrowserUseSessionCdpUrl(sessionId)
    ).resolves.toBeUndefined();
  });

  it("lists a run's saved pictures with their download links", async () => {
    const client = await loadClient();
    const workspaceId = "33333333-3333-4333-8333-333333333333";
    const calls = stubFetch(
      Response.json({
        files: [
          {
            lastModified: "2026-09-22T10:05:00Z",
            path: "report/final.png",
            size: 2048,
            url: "https://workspace.browser-use.test/final.png?signature=x",
          },
        ],
        hasMore: false,
        nextCursor: null,
      })
    );

    const listed = await client.listBrowserUseWorkspaceFiles(
      workspaceId,
      "report/"
    );

    expect(listed.files[0]?.path).toBe("report/final.png");
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe(`/api/v4/workspaces/${workspaceId}/files`);
    expect(url.searchParams.get("prefix")).toBe("report/");
    expect(url.searchParams.get("includeUrls")).toBe("true");
    expect(calls[0]?.method).toBe("GET");
  });

  it("reads the workspace a finished run saved its files into", async () => {
    const client = await loadClient();
    stubFetch(
      Response.json({
        createdAt: "2026-09-22T10:00:00Z",
        error: null,
        id: runId,
        result: "RESULT: done",
        sessionId,
        status: "completed",
        task: "Order the usual",
        workspaceId: "33333333-3333-4333-8333-333333333333",
      })
    );

    const run = await client.readBrowserUseRun(runId);

    expect(run.workspaceId).toBe("33333333-3333-4333-8333-333333333333");
    expect(run.createdAt).toBe("2026-09-22T10:00:00Z");
  });

  it("refuses to call the API without a configured key", async () => {
    vi.resetModules();
    vi.stubEnv("BROWSER_USE_API_KEY", "");
    const client = await import("@agent/lib/browser-use/client");
    expect(client.browserUseConfigured()).toBe(false);
    await expect(client.readBrowserUseRunStatus(runId)).rejects.toThrow(
      "BROWSER_USE_API_KEY is not configured."
    );
  });
});
