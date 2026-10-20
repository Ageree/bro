import type * as Undici from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as RequestScope from "@web/auth/request-scope";
import type { requireRequestScope } from "@web/auth/request-scope";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, init: { body: string }) => Promise<Response>>(),
  requireRequestScope: vi.fn<typeof requireRequestScope>(),
}));

vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof Undici>()),
  fetch: mocks.fetch,
}));
vi.mock("@web/auth/request-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof RequestScope>()),
  requireRequestScope: mocks.requireRequestScope,
}));
vi.mock("@db/services/settings", () => ({
  getFormOfAddress: async () => await Promise.resolve({ formal: false }),
}));
vi.mock("@db/services/user-profile", () => ({
  readUserProfile: async () =>
    await Promise.resolve({ firstName: "Аня", timezone: "Europe/Moscow" }),
}));

const scope = { userId: "alice", workspaceId: "personal:alice" };
vi.stubEnv("OPENAI_API_KEY", "sk-test-voice");
vi.stubEnv("VOICE_WORKSPACES", scope.workspaceId);
const { POST } = await import("../route");

function offer() {
  return new Request("https://bro.example/api/voice/session", {
    body: "v=0 offer",
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue(
    Response.json(
      { session: { id: "live_1" }, transport: { sdp: "v=0 answer" } },
      { status: 201 }
    )
  );
});

describe("opening a voice session", () => {
  it("hands the page's offer to GPT-Live with client delegation and returns its answer", async () => {
    mocks.requireRequestScope.mockResolvedValue(scope);

    const response = await POST(offer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/sdp");
    expect(await response.text()).toBe("v=0 answer");
    const [url, init] = mocks.fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/live/sessions");
    expect(JSON.parse(init?.body ?? "{}")).toMatchObject({
      session: { delegation: { type: "client" }, model: "gpt-live-1" },
      transport: { sdp: "v=0 offer", type: "webrtc" },
    });
  });

  it("does not exist for a workspace outside the pilot", async () => {
    mocks.requireRequestScope.mockResolvedValue({
      userId: "bob",
      workspaceId: "personal:bob",
    });

    const response = await POST(offer());

    expect(response.status).toBe(404);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
