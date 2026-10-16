import type { RouteHandlerArgs } from "eve/channels";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getAuthSession } from "@db/services/auth/session";
import type { ensureScope } from "@db/services/scope";
import type { claimSession, isSessionOwned } from "@db/services/sessions";
import { authSessionFor } from "@tests/helpers/auth-session";

const messageRoutes = ["/eve/v1/session", "/eve/v1/session/:sessionId"];

const mocks = vi.hoisted(() => ({
  claimSession: vi.fn<typeof claimSession>(),
  ensureScope: vi.fn<typeof ensureScope>(),
  getAuthSession: vi.fn<typeof getAuthSession>(),
  handle: vi.fn<(request: Request) => Promise<Response>>(),
  isSessionOwned: vi.fn<typeof isSessionOwned>(),
}));

// eve parses the whole body before its own checks; this stand-in reads it
// the same way and answers an unreadable one as eve does, with a 400.
vi.mock(import("eve/channels/eve"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    eveChannel(config) {
      const channel = original.eveChannel(config);
      return {
        ...channel,
        // oxlint-disable-next-line oxc/no-map-spread -- Swaps the message handlers while keeping eve's route definitions intact.
        routes: channel.routes.map((route) =>
          route.transport !== "websocket" &&
          route.method === "POST" &&
          messageRoutes.includes(route.path)
            ? { ...route, handler: mocks.handle }
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

const bound = 64 * 1024 * 1024;

describe("Eve message size", () => {
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
    mocks.isSessionOwned.mockResolvedValue(true);
    mocks.handle.mockImplementation(async (request) => {
      try {
        await request.text();
      } catch {
        return Response.json(
          { error: "Invalid JSON body.", ok: false },
          { status: 400 }
        );
      }
      return Response.json(
        { ok: true, sessionId: "wrun_1", status: "accepted" },
        { headers: { "x-eve-session-id": "wrun_1" }, status: 202 }
      );
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it.each(messageRoutes)(
    "refuses a declared body over 64 MiB on %s before reading it",
    async (path) => {
      const response = await messageRoute(path).handler(
        new Request(url(path), {
          body: "{}",
          headers: { "content-length": String(bound + 1) },
          method: "POST",
        }),
        routeContext()
      );

      expect(response.status).toBe(413);
      expect(mocks.handle).not.toHaveBeenCalled();
    }
  );

  it("passes a body of exactly 64 MiB on", async () => {
    const path = "/eve/v1/session/:sessionId";
    const response = await messageRoute(path).handler(
      new Request(url(path), {
        body: "{}",
        headers: { "content-length": String(bound) },
        method: "POST",
      }),
      routeContext()
    );

    expect(response.status).toBe(202);
    expect(mocks.handle).toHaveBeenCalledOnce();
  });

  // A proxy may drop `Content-Length`: such a body still arrives whole while
  // it fits, and is cut where it outgrows the bound.
  it("reads a body without a length to its end while it fits", async () => {
    const path = "/eve/v1/session/:sessionId";
    const response = await messageRoute(path).handler(
      streamedRequest(path, 3, 1024 * 1024).request,
      routeContext()
    );

    expect(response.status).toBe(202);
  });

  // Node drops an unread body's rest only when nothing began to read it: left
  // in the connection, it would break the next request sent over it.
  it("cuts a body without a length past 64 MiB and drops its rest", async () => {
    const path = "/eve/v1/session";
    const streamed = streamedRequest(path, 66, 1024 * 1024);
    const response = await messageRoute(path).handler(
      streamed.request,
      routeContext()
    );

    expect(response.status).toBe(413);
    expect(mocks.claimSession).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(streamed.readToEnd()).toBe(true);
    });
  });
});

function url(path: string) {
  return `https://assistant.example${path.replace(":sessionId", "wrun_1")}`;
}

/** A body without a length, as a proxy that dropped the header passes it. */
function streamedRequest(path: string, chunks: number, chunkBytes: number) {
  const chunk = new Uint8Array(chunkBytes).fill(32);
  const state = { ended: false, sent: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.sent === chunks) {
        state.ended = true;
        controller.close();
        return;
      }
      state.sent += 1;
      controller.enqueue(chunk);
    },
  });
  const init = { body, duplex: "half", method: "POST" };
  return {
    readToEnd: () => state.ended,
    request: new Request(url(path), init),
  };
}

function messageRoute(path: string) {
  const route = eveChannel.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" &&
      candidate.method === "POST" &&
      candidate.path === path
  );
  if (!route || route.transport === "websocket") {
    throw new Error(`The Eve route ${path} is unavailable.`);
  }
  return route;
}

function routeContext() {
  return {
    attachSession: unexpectedRouteRequest,
    from: unexpectedRouteRequest,
    params: { sessionId: "wrun_1" },
    requestIp: null,
    resolveSession: unexpectedRouteRequest,
    to: unexpectedRouteRequest,
    waitUntil: unexpectedRouteRequest,
  } satisfies RouteHandlerArgs;
}

function unexpectedRouteRequest(): never {
  throw new Error("The message route stand-in needs no runtime access.");
}
