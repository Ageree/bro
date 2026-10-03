import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  errandUsageCosts,
  summarizeUsageCosts,
} from "@db/services/usage-costs";

const mocks = vi.hoisted(() => ({
  errandUsageCosts: vi.fn<typeof errandUsageCosts>(),
  summarizeUsageCosts: vi.fn<typeof summarizeUsageCosts>(),
}));
vi.mock("@db/services/usage-costs", () => mocks);

const token = "owner-cost-report-token-0123456789abcdef";

async function loadRoute(configured: string) {
  vi.resetModules();
  vi.stubEnv("USAGE_REPORT_TOKEN", configured);
  return import("@app/api/usage-costs/route");
}

function ask(query: string, bearer?: string) {
  return new Request(`https://bro.example/api/usage-costs${query}`, {
    headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
  });
}

const summary = {
  from: "2026-08-31T21:00:00.000Z",
  month: "2026-09",
  to: "2026-09-30T21:00:00.000Z",
  totalRub: 0,
  workspaces: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.summarizeUsageCosts.mockResolvedValue(summary);
  mocks.errandUsageCosts.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.stubEnv("USAGE_REPORT_TOKEN", "");
});

describe("the owner's cost report", () => {
  it("does not exist without its token configured", async () => {
    const { GET } = await loadRoute("");
    const response = await GET(ask("?month=2026-09", token));
    expect(response.status).toBe(404);
    expect(mocks.summarizeUsageCosts).not.toHaveBeenCalled();
  });

  it("answers only the bearer of the token", async () => {
    const { GET } = await loadRoute(token);
    expect((await GET(ask("?month=2026-09"))).status).toBe(401);
    expect((await GET(ask("?month=2026-09", `${token}x`))).status).toBe(401);
    expect(mocks.summarizeUsageCosts).not.toHaveBeenCalled();

    const response = await GET(ask("?month=2026-09", token));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(summary);
    expect(mocks.summarizeUsageCosts).toHaveBeenCalledExactlyOnceWith(
      "2026-09"
    );
  });

  it("refuses a month not written as YYYY-MM", async () => {
    const { GET } = await loadRoute(token);
    expect((await GET(ask("?month=September", token))).status).toBe(400);
  });

  it("breaks one errand down by its run id", async () => {
    const { GET } = await loadRoute(token);
    expect((await GET(ask("?run=run-1", token))).status).toBe(404);

    mocks.errandUsageCosts.mockResolvedValue({
      bySource: {
        background: 0,
        "browser-report": 1,
        "browser-run": 2,
        "browser-vm": 0,
        chat: 0,
        memory: 0,
        proxy: 0,
        task: 0,
      },
      items: [],
      runId: "run-1",
      totalRub: 3,
      workspaceId: "personal:alice",
    });
    const response = await GET(ask("?run=run-1", token));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      runId: "run-1",
      totalRub: 3,
    });
  });
});
