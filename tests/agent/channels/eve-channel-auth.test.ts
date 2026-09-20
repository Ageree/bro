import type { RouteHandlerArgs } from "eve/channels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as AuthSession from "@db/services/auth/session";
import * as SessionService from "@db/services/sessions";
import { authSessionFor } from "@tests/helpers/auth-session";
import eveChannel, { sessionIdFromPath } from "@agent/channels/eve";

const getAuthSessionMock = vi.spyOn(AuthSession, "getAuthSession");
const isSessionOwnedMock = vi.spyOn(SessionService, "isSessionOwned");

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  getAuthSessionMock.mockResolvedValue(
    authSessionFor({
      id: "user-1",
      phoneNumber: "+12025550123",
      phoneNumberVerified: true,
    })
  );
  isSessionOwnedMock.mockResolvedValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Eve channel authentication", () => {
  it("checks decoded session route ids against workspace ownership", async () => {
    const route = eveChannel.routes.find(
      (candidate) =>
        candidate.transport !== "websocket" &&
        candidate.method === "GET" &&
        candidate.path === "/eve/v1/session/:sessionId/stream"
    );
    if (!route || route.transport === "websocket") {
      throw new Error("The Eve session stream route is unavailable.");
    }

    const responsePromise = route.handler(
      new Request(
        "https://assistant.example/eve/v1/session/session%2Fone/stream"
      ),
      unexpectedRouteContext()
    );
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(403);
    expect(isSessionOwnedMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "better-auth:user-1" }),
      "session/one"
    );
  });

  it("checks hook-resume routes against the session named in the token", async () => {
    const route = findRoute("POST", "/eve/v1/callback/:token");

    const responsePromise = route.handler(
      new Request(
        "https://assistant.example/eve/v1/callback/eve%3Asession%3Awrun_victim%3Ainbox",
        { body: "{}", method: "POST" }
      ),
      unexpectedRouteContext()
    );
    await vi.runAllTimersAsync();
    const response = await responsePromise;

    expect(response.status).toBe(403);
    expect(isSessionOwnedMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "better-auth:user-1" }),
      "wrun_victim"
    );
  });

  it.each(["GET", "POST"] as const)(
    "guards %s on the expired connection callback before invoking it",
    async (method) => {
      const route = findRoute(
        method,
        "/eve/v1/connections/:name/callback/:token"
      );
      const pending = route.handler(
        new Request(
          "https://assistant.example/eve/v1/connections/google/callback/eve%3Asession%3Awrun_victim%3Ainbox",
          { method }
        ),
        unexpectedRouteContext()
      );
      await vi.runAllTimersAsync();
      expect((await pending).status).toBe(403);
      expect(isSessionOwnedMock).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "better-auth:user-1" }),
        "wrun_victim"
      );
    }
  );

  // The browser that finishes the Google consent screen carries no Bro cookie:
  // people connect Gmail from iMessage or Telegram, not from a signed-in tab.
  // Asking it to sign in answered every finished consent with 401 and the
  // grant was never stored. Eve authorizes this route by the attempt id it
  // minted, so it stays open to an anonymous return.
  it.each(["GET", "POST"] as const)(
    "lets the %s OAuth return through without a Bro session",
    async (method) => {
      getAuthSessionMock.mockResolvedValue(null);
      const route = findRoute(
        method,
        "/eve/v1/connections/:name/callback/:attemptId/:token"
      );

      const response = await route.handler(
        new Request(
          "https://assistant.example/eve/v1/connections/gmail-search__google/callback/01M2Z8ZRRTDR514VWB6ZEW799V/eve%3Ainbox%3Av1%3Aeve%3Asession%3Awrun_1%3Ainbox",
          { method }
        ),
        connectionCallbackContext()
      );

      // Eve's own handler answers — here, that this attempt is no longer
      // parked — rather than this app's sign-in boundary.
      expect(await response.json()).toStrictEqual({
        error: "Connection callback not pending.",
        ok: false,
      });
      expect(response.status).toBe(404);
      expect(getAuthSessionMock).not.toHaveBeenCalled();
    }
  );

  it("fails closed on routes whose subject cannot be resolved", async () => {
    const route = findRoute("POST", "/eve/v1/task-input/:token");

    const response = await route.handler(
      new Request(
        "https://assistant.example/eve/v1/task-input/eve:task-input:0123456789abcdef0123456789abcdef",
        { body: "{}", method: "POST" }
      ),
      unexpectedRouteContext()
    );

    expect(response.status).toBe(403);
    expect(isSessionOwnedMock).not.toHaveBeenCalled();
  });

  it("extracts session ids from paths and derived hook tokens", () => {
    expect(sessionIdFromPath("/eve/v1/session/wrun_1/stream")).toBe("wrun_1");
    expect(sessionIdFromPath("/eve/v1/callback/eve:session:wrun_1:inbox")).toBe(
      "wrun_1"
    );
    // Eve wraps an authorization hook token in the session-inbox envelope.
    expect(
      sessionIdFromPath(
        "/eve/v1/callback/eve:inbox:v1:eve:session:wrun_1:inbox"
      )
    ).toBe("wrun_1");
    expect(
      sessionIdFromPath(
        "/eve/v1/connections/google/callback/eve:session:wrun_1:inbox"
      )
    ).toBe("wrun_1");
    // Token shapes eve no longer mints resolve to nothing and fail closed.
    expect(
      sessionIdFromPath("/eve/v1/callback/wrun_1:turn-control:3:cancel")
    ).toBeUndefined();
    expect(
      sessionIdFromPath("/eve/v1/connections/google/callback/wrun_1:auth")
    ).toBeUndefined();
    expect(
      sessionIdFromPath(
        "/eve/v1/callback/task:task_1:0123456789abcdef0123456789abcdef"
      )
    ).toBeUndefined();
    expect(
      sessionIdFromPath("/eve/v1/task-input/eve:task-input:abc")
    ).toBeUndefined();
    expect(sessionIdFromPath("/eve/v1/session")).toBeUndefined();
  });
});

function findRoute(method: string, path: string) {
  const route = eveChannel.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" &&
      candidate.method === method &&
      candidate.path === path
  );
  if (!route || route.transport === "websocket") {
    throw new Error(`The Eve route ${method} ${path} is unavailable.`);
  }
  return route;
}

// The OAuth return reaches eve's own handler, which reads the callback
// coordinates from the route params.
function connectionCallbackContext() {
  return {
    ...unexpectedRouteContext(),
    params: {
      attemptId: "01M2Z8ZRRTDR514VWB6ZEW799V",
      name: "gmail-search__google",
      token: "eve:inbox:v1:eve:session:wrun_1:inbox",
    },
  } satisfies RouteHandlerArgs;
}

function unexpectedRouteContext() {
  return {
    attachSession: unexpectedRouteRequest,
    from: unexpectedRouteRequest,
    params: { sessionId: "session/one" },
    requestIp: null,
    resolveSession: unexpectedRouteRequest,
    to: unexpectedRouteRequest,
    waitUntil: unexpectedRouteRequest,
  } satisfies RouteHandlerArgs;
}

function unexpectedRouteRequest(): never {
  throw new Error("The request should stop at authorization.");
}
