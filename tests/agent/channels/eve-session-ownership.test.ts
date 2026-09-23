import type { RouteHandlerArgs } from "eve/channels";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getAuthSession } from "@db/services/auth/session";
import type { ensureScope } from "@db/services/scope";
import type { claimSession, isSessionOwned } from "@db/services/sessions";
import { authSessionFor } from "@tests/helpers/auth-session";
import { accessScopeForUser } from "@shared/identity/access-scope";

const mocks = vi.hoisted(() => ({
  claimSession: vi.fn<typeof claimSession>(),
  createSession: vi.fn<() => Promise<Response>>(),
  ensureScope: vi.fn<typeof ensureScope>(),
  getAuthSession: vi.fn<typeof getAuthSession>(),
  isSessionOwned: vi.fn<typeof isSessionOwned>(),
}));

// eve's own create handler starts a Workflow run; this stand-in answers the
// way it does, `202` with the new id, so the test sees what the browser sees.
vi.mock(import("eve/channels/eve"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    eveChannel(config) {
      const channel = original.eveChannel(config);
      return {
        ...channel,
        // oxlint-disable-next-line oxc/no-map-spread -- Swaps one handler while keeping eve's route definitions intact.
        routes: channel.routes.map((route) =>
          route.transport !== "websocket" &&
          route.method === "POST" &&
          route.path === "/eve/v1/session"
            ? { ...route, handler: mocks.createSession }
            : route
        ),
      };
    },
  };
});
vi.mock("@db/services/auth/session", () => ({
  getAuthSession: mocks.getAuthSession,
}));
vi.mock("@db/services/scope", () => ({ ensureScope: mocks.ensureScope }));
vi.mock("@db/services/sessions", () => ({
  claimSession: mocks.claimSession,
  isSessionOwned: mocks.isSessionOwned,
}));

const { default: eveChannel } = await import("@agent/channels/eve");

const scope = accessScopeForUser("better-auth:user-1");

describe("Eve session creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthSession.mockResolvedValue(
      authSessionFor({
        id: "user-1",
        phoneNumber: "+12025550123",
        phoneNumberVerified: true,
      })
    );
    mocks.ensureScope.mockResolvedValue(undefined);
    mocks.claimSession.mockResolvedValue(undefined);
    mocks.createSession.mockResolvedValue(acceptedSession("wrun_new"));
  });

  // eve answers the create request before `session.started`, which waits for
  // the first message. The browser opens the stream right away, so the owner
  // must already be on record when the id reaches it.
  it("records the caller as owner before the new session id is returned", async () => {
    mocks.createSession.mockImplementation(async () => {
      expect(mocks.claimSession).not.toHaveBeenCalled();
      return acceptedSession("wrun_new");
    });

    const response = await createRoute().handler(
      new Request("https://assistant.example/eve/v1/session", {
        method: "POST",
      }),
      routeContext()
    );

    expect(response.status).toBe(202);
    expect(mocks.ensureScope).toHaveBeenCalledWith(scope);
    expect(mocks.claimSession).toHaveBeenCalledExactlyOnceWith(
      scope,
      "wrun_new"
    );
    expect(mocks.ensureScope.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claimSession.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("reads the new session id from the body when the header is missing", async () => {
    mocks.createSession.mockResolvedValue(
      Response.json(
        { ok: true, sessionId: "wrun_body", status: "accepted" },
        { status: 202 }
      )
    );

    const response = await createRoute().handler(
      new Request("https://assistant.example/eve/v1/session", {
        method: "POST",
      }),
      routeContext()
    );

    expect(await response.json()).toMatchObject({ sessionId: "wrun_body" });
    expect(mocks.claimSession).toHaveBeenCalledExactlyOnceWith(
      scope,
      "wrun_body"
    );
  });

  it("still returns the new session when recording its owner fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.claimSession.mockRejectedValue(new Error("database unavailable"));

    const response = await createRoute().handler(
      new Request("https://assistant.example/eve/v1/session", {
        method: "POST",
      }),
      routeContext()
    );

    expect(response.status).toBe(202);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("claims nothing for a create request eve refused", async () => {
    mocks.createSession.mockResolvedValue(
      Response.json({ code: "bad_request", ok: false }, { status: 400 })
    );

    const response = await createRoute().handler(
      new Request("https://assistant.example/eve/v1/session", {
        method: "POST",
      }),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mocks.claimSession).not.toHaveBeenCalled();
  });

  it("asks a signed-out caller to sign in before eve creates anything", async () => {
    mocks.getAuthSession.mockResolvedValue(null);

    const response = await createRoute().handler(
      new Request("https://assistant.example/eve/v1/session", {
        method: "POST",
      }),
      routeContext()
    );

    expect(response.status).toBe(401);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.claimSession).not.toHaveBeenCalled();
  });
});

function acceptedSession(sessionId: string) {
  return Response.json(
    { ok: true, sessionId, status: "accepted" },
    { headers: { "x-eve-session-id": sessionId }, status: 202 }
  );
}

function createRoute() {
  const route = eveChannel.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" &&
      candidate.method === "POST" &&
      candidate.path === "/eve/v1/session"
  );
  if (!route || route.transport === "websocket") {
    throw new Error("The Eve session creation route is unavailable.");
  }
  return route;
}

function routeContext() {
  return {
    attachSession: unexpectedRouteRequest,
    from: unexpectedRouteRequest,
    params: {},
    requestIp: null,
    resolveSession: unexpectedRouteRequest,
    to: unexpectedRouteRequest,
    waitUntil: unexpectedRouteRequest,
  } satisfies RouteHandlerArgs;
}

function unexpectedRouteRequest(): never {
  throw new Error("The create route stand-in needs no runtime access.");
}
