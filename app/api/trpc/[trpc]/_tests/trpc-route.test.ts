import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { revealBroLogin } from "@db/services/bro-logins";
import type * as requestScope from "@web/auth/request-scope";

const mocks = vi.hoisted(() => ({
  requireRequestScope: vi.fn<typeof requestScope.requireRequestScope>(),
  revealBroLogin: vi.fn<typeof revealBroLogin>(),
}));
vi.mock("@web/auth/request-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof requestScope>()),
  requireRequestScope: mocks.requireRequestScope,
}));
vi.mock("@db/services/bro-logins", () => ({
  listBroLoginIds: vi.fn<() => Promise<string[]>>(),
  revealBroLogin: mocks.revealBroLogin,
}));

const scope = { userId: "alice", workspaceId: "workspace:alice" };

function reveal(id: string) {
  return new Request("https://bro.example/api/trpc/vault.reveal", {
    body: JSON.stringify({ id }),
    headers: {
      "content-type": "application/json",
      origin: "https://bro.example",
    },
    method: "POST",
  });
}

// The router's first import transforms every service it reaches, which can
// outlast one test's five seconds on its own.
beforeAll(async () => {
  await import("@app/api/trpc/[trpc]/route");
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRequestScope.mockResolvedValue(scope);
  mocks.revealBroLogin.mockImplementation(async (_scope, id) =>
    id === "bro"
      ? { email: "quiet.fox42@agentmail.to", password: "Gen3rated!Pass" }
      : undefined
  );
});

describe("the vault read-back over tRPC", () => {
  it("answers the owner with Bro's login, never to be cached", async () => {
    const { POST } = await import("@app/api/trpc/[trpc]/route");

    const response = await POST(reveal("bro"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("Gen3rated!Pass");
    expect(mocks.revealBroLogin).toHaveBeenCalledWith(scope, "bro");
  });

  it("says only «not found» for anything else", async () => {
    const { POST } = await import("@app/api/trpc/[trpc]/route");

    const response = await POST(reveal("own"));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("password");
  });

  it("reads nothing without a session", async () => {
    const { UnauthenticatedError } = await import("@web/auth/request-scope");
    mocks.requireRequestScope.mockRejectedValue(new UnauthenticatedError());
    const { POST } = await import("@app/api/trpc/[trpc]/route");

    const response = await POST(reveal("bro"));

    expect(response.status).toBe(401);
    expect(mocks.revealBroLogin).not.toHaveBeenCalled();
  });
});
