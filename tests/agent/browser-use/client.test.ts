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
