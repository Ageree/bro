import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as RequestScope from "@web/auth/request-scope";
import type { requireRequestScope } from "@web/auth/request-scope";

const mocks = vi.hoisted(() => ({
  requireRequestScope: vi.fn<typeof requireRequestScope>(),
}));

vi.mock("@web/auth/request-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof RequestScope>()),
  requireRequestScope: mocks.requireRequestScope,
}));

const scope = { userId: "alice", workspaceId: "personal:alice" };
vi.stubEnv("OPENAI_API_KEY", "sk-test-voice");
vi.stubEnv("VOICE_WORKSPACES", scope.workspaceId);
const { POST } = await import("../route");

function event(body: string) {
  return new Request("https://bro.example/api/voice/event", {
    body,
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the voice page's journal", () => {
  it("writes the kind of what the page did, and nothing the person said", async () => {
    mocks.requireRequestScope.mockResolvedValue(scope);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const response = await POST(
      event(JSON.stringify({ kind: "answer_sent", words: "бери первое" }))
    );

    expect(response.status).toBe(204);
    expect(info).toHaveBeenCalledExactlyOnceWith("[voice] page", {
      kind: "answer_sent",
      workspaceId: scope.workspaceId,
    });
  });

  it("takes no unknown kind and nothing outside the pilot", async () => {
    mocks.requireRequestScope.mockResolvedValue(scope);
    expect((await POST(event('{"kind":"anything"}'))).status).toBe(400);
    expect((await POST(event("not json"))).status).toBe(400);

    mocks.requireRequestScope.mockResolvedValue({
      userId: "bob",
      workspaceId: "personal:bob",
    });
    expect((await POST(event('{"kind":"sent"}'))).status).toBe(404);
  });
});
