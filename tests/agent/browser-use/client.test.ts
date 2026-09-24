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
      init: { body?: string; headers: HeadersInit; method: string }
    ) => {
      calls.push({
        body: init.body ?? "",
        headers: new Headers(init.headers),
        method: init.method,
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

  it("finds a recent run by an exact task line, a page at a time", async () => {
    const client = await loadClient();
    const line = "(Background retry 2 of errand run-1; for bookkeeping only.)";
    const summary = (id: string, task: string) => ({
      id,
      sessionId,
      status: "running",
      task,
    });
    const calls = stubFetch(
      Response.json({
        hasMore: true,
        nextCursor: "page-2",
        runs: [summary("other", `Купи\n\n${line} and more`)],
      }),
      Response.json({
        hasMore: true,
        nextCursor: "page-3",
        runs: [summary("orphan", `Купи\n\n${line}`)],
      })
    );

    const found = await client.findRecentBrowserUseRunByTaskLine(line);

    expect(found?.id).toBe("orphan");
    expect(calls.map((call) => call.url)).toEqual([
      `${baseUrl}/runs?limit=50`,
      `${baseUrl}/runs?limit=50&cursor=page-2`,
    ]);
  });

  it("never adopts a cancelled run that carries the line", async () => {
    const client = await loadClient();
    const line = "(Queued errand queued:1, change 1; for bookkeeping only.)";
    stubFetch(
      Response.json({
        hasMore: false,
        runs: [
          { id: "given-up", sessionId, status: "cancelled", task: line },
          { id: "live", sessionId, status: "running", task: line },
        ],
      })
    );

    expect((await client.findRecentBrowserUseRunByTaskLine(line))?.id).toBe(
      "live"
    );
  });

  it("stops looking after the pages it was given", async () => {
    const client = await loadClient();
    const calls = stubFetch(
      Response.json({ hasMore: true, nextCursor: "next", runs: [] })
    );

    expect(
      await client.findRecentBrowserUseRunByTaskLine("missing", 2)
    ).toBeUndefined();
    expect(calls).toHaveLength(2);
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

  it("does not repeat a start Browser Use refused for want of a free browser", async () => {
    const client = await loadClient();
    const calls = stubFetch(
      Response.json(
        {
          detail: "Too many concurrent active sessions",
          retry_after_seconds: 90,
        },
        { status: 429 }
      )
    );

    const failure = await client
      .createBrowserUseRun({ task: "Найди отель" })
      .catch((cause: unknown) => cause);

    expect(client.browserUseBusy(failure)).toBe(true);
    expect(client.browserUseOutOfCredits(failure)).toBe(false);
    expect(failure).toMatchObject({ retryAfterMs: 90_000, status: 429 });
    expect(calls).toHaveLength(1);
  });

  it("reads an edge throttle's wait from its header and knows a 402", async () => {
    const client = await loadClient();
    stubFetch(
      new Response('{"error":"rate_limited"}', {
        headers: { "retry-after": "300" },
        status: 429,
      })
    );
    const throttled = await client
      .readBrowserUseRunStatus(runId)
      .catch((cause: unknown) => cause);
    expect(throttled).toMatchObject({ retryAfterMs: 300_000 });

    // The header may name the moment instead of the seconds.
    stubFetch(
      new Response('{"error":"rate_limited"}', {
        headers: {
          "retry-after": new Date(Date.now() + 120_000).toUTCString(),
        },
        status: 429,
      })
    );
    const dated = await client
      .createBrowserUseRun({ task: "Найди отель" })
      .catch((cause: unknown) => cause);
    expect(client.browserUseBusy(dated)).toBe(true);
    const datedWaitMs = client.browserUseBusy(dated)
      ? dated.retryAfterMs
      : undefined;
    expect(datedWaitMs).toBeGreaterThan(115_000);
    expect(datedWaitMs).toBeLessThanOrEqual(120_000);

    stubFetch(new Response("Insufficient credits", { status: 402 }));
    const broke = await client
      .createBrowserUseRun({ task: "Найди отель" })
      .catch((cause: unknown) => cause);
    expect(client.browserUseOutOfCredits(broke)).toBe(true);
  });

  it("reads a run status, queues a session message and stops a session", async () => {
    const client = await loadClient();
    const calls = stubFetch(
      Response.json({ status: "completed" }),
      Response.json({ id: 7, sessionId, status: "pending" }),
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
      `DELETE ${baseUrl}/sessions/${sessionId}`,
    ]);
    expect(JSON.parse(calls[1]?.body ?? "")).toEqual({ text: "123456" });
  });

  it("takes the live view url from the browser.ready event", async () => {
    const client = await loadClient();
    stubFetch(
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

    const page = await client.listBrowserUseRunEvents(runId);
    expect(client.liveViewUrlFromEvents(page.events)).toBe(
      "https://live.browser-use.test/abc"
    );
    expect(client.liveViewUrlFromEvents([])).toBeUndefined();
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

    await expect(client.findBrowserUseSessionCdpUrl(sessionId)).resolves.toBe(
      "wss://cdp.browser-use.test/live"
    );
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(`${baseUrl}/browsers`);
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
