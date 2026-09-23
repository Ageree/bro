import { defaultEveAuth, eveChannel } from "eve/channels/eve";
import {
  ForbiddenError,
  localDev,
  routeAuth,
  UnauthenticatedError,
} from "eve/channels/auth";
import { z } from "zod";
import { claimSession, isSessionOwned } from "@db/services/sessions";
import { ensureScope } from "@db/services/scope";
import { firstContactContext } from "@agent/lib/first-contact";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";
import { getAuthSession } from "@db/services/auth/session";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import {
  finalizeScheduledReportDelivery,
  releaseScheduledReportDelivery,
  scheduledReportFromSession,
} from "@agent/lib/schedules/report-lifecycle";

const authenticateLocalDev = localDev();

const authenticate: Parameters<typeof routeAuth>[1] = [
  async (request) => {
    const identity = await requestIdentityFromRequest(request);
    if (!identity) return null;
    const { phoneNumber, scope } = identity;

    await requireOwnedRouteSubject(scope, request);

    return {
      attributes: {
        conversationChannel: "eve",
        phoneNumber,
        workspaceId: scope.workspaceId,
      },
      authenticator: "authjs",
      principalId: scope.userId,
      principalType: "user",
    };
  },
  async (request) => {
    const local = await authenticateLocalDev(request);
    if (!local) return null;

    const scope = accessScopeForUser("better-auth:browser-benchmark");
    await requireOwnedRouteSubject(scope, request);

    return {
      ...local,
      attributes: {
        ...local.attributes,
        conversationChannel: "eve",
        phoneNumber: "+15555550100",
        workspaceId: scope.workspaceId,
      },
      principalId: scope.userId,
      principalType: "user" as const,
    };
  },
  () => {
    throw new UnauthenticatedError({
      code: "authentication_required",
      message: "Sign in to continue.",
    });
  },
];

const channel = eveChannel({
  auth: authenticate,
  // Someone who signs up on the web and writes there first meets Bro here, so
  // this channel opens a workspace's first conversation the same way the
  // messaging channels do.
  async onMessage(context) {
    const auth = defaultEveAuth(context);
    // Route auth above resolves a workspace user or has already refused the
    // request, so a missing caller is a broken invariant, not a guest.
    if (!auth) throw new Error("An eve message arrived without a caller.");
    return {
      auth,
      context: await firstContactContext(scopeFromPrincipal(auth)),
    };
  },
  events: {
    async "action.result"(event, _channel, session) {
      if (
        event.status === "completed" &&
        sendMessageToolResultSchema.safeParse(event.result).success
      ) {
        await finalizeScheduledReportDelivery(session);
      }
    },
    async "message.completed"(event, _channel, session) {
      if (event.finishReason === "tool-calls") return;
      if (scheduledReportFromSession(session)) {
        await finalizeScheduledReportDelivery(session, "suppressed");
      }
    },
    async "session.completed"(_event, _channel, session) {
      if (scheduledReportFromSession(session)) {
        await finalizeScheduledReportDelivery(session, "suppressed");
      }
    },
    async "turn.cancelled"(_event, _channel, session) {
      await releaseScheduledReportDelivery(
        session,
        "Scheduled result reporting was cancelled."
      );
    },
    async "turn.failed"(event, _channel, session) {
      await releaseScheduledReportDelivery(session, event.message);
    },
  },
});

// Eve callback handlers authenticate their capability tokens internally. Apply
// this app's caller and workspace ownership policy at the public route boundary.
//
// The attempt-scoped connection callback
// (`/eve/v1/connections/:name/callback/:attemptId/:token`) is deliberately not
// here. It is the URL Google and Vercel Connect send the person's browser to
// after consent, and that browser carries no Bro cookie: people connect Gmail
// from iMessage or Telegram, not from a signed-in tab. Guarding it answered
// every finished consent screen with `401 authentication_required`, so the
// grant was never stored and the mail never connected. It is also the one
// token route that does not need the guard: eve mints a fresh ULID per
// attempt, matches the callback against the parked challenge by that exact
// attempt id, and resumes nothing once the hook is gone. The routes below keep
// the guard because their token is derived from the session id alone, which is
// not a secret.
const ownedCallbackRoutes = new Set([
  "/eve/v1/connections/:name/callback/:token",
  "/eve/v1/callback/:token",
  "/eve/v1/task-input/:token",
]);

const sessionCreationRoute = "/eve/v1/session";

export default {
  ...channel,
  // oxlint-disable-next-line oxc/no-map-spread -- Keep Eve's original route definitions intact when adding the app authorization boundary.
  routes: channel.routes.map((route) => {
    if (route.transport === "websocket") return route;
    if (route.method === "POST" && route.path === sessionCreationRoute) {
      return {
        ...route,
        async handler(request, context) {
          const principal = await routeAuth(request, authenticate);
          if (principal instanceof Response) return principal;
          const response = await route.handler(request, context);
          await claimCreatedSession(principal, response);
          return response;
        },
      };
    }
    if (!ownedCallbackRoutes.has(route.path)) return route;
    return {
      ...route,
      async handler(request, context) {
        const principal = await routeAuth(request, authenticate);
        if (principal instanceof Response) return principal;
        return route.handler(request, context);
      },
    };
  }),
} satisfies typeof channel;

/**
 * Records who owns a session before its id reaches the browser. eve answers
 * the create request as soon as Workflow accepts the run, and `session.started`
 * (where the owner hook claims it) fires only once the first message arrives,
 * so a client that opened the stream right away used to be refused as a
 * stranger to its own new session.
 */
async function claimCreatedSession(
  principal: Parameters<typeof scopeFromPrincipal>[0],
  response: Response
) {
  if (!response.ok) return;
  const sessionId =
    response.headers.get("x-eve-session-id") ??
    createdSessionSchema.safeParse(
      await response
        .clone()
        .json()
        .catch(() => undefined)
    ).data?.sessionId;
  if (!sessionId) return;
  const scope = scopeFromPrincipal(principal);
  try {
    await ensureScope(scope);
    await claimSession(scope, sessionId);
  } catch (error) {
    // The session exists either way. The owner hook claims it with the first
    // message, and the stream route waits for that claim.
    console.warn("[eve] session ownership was not recorded at creation", {
      cause: error,
      sessionId,
    });
  }
}

const createdSessionSchema = z.object({ sessionId: z.string().min(1) });

// Routes without a session subject. Every other eve route must name a session
// this caller owns, either in the path or inside a hook token.
const subjectFreeRoutes = new Set(["/eve/v1/info", "/eve/v1/session"]);

async function requireOwnedRouteSubject(scope: AccessScope, request: Request) {
  const { pathname } = new URL(request.url);
  if (subjectFreeRoutes.has(pathname)) return;
  const sessionId = sessionIdFromPath(pathname);
  if (!sessionId || !(await waitForSessionOwnership(scope, sessionId))) {
    throw new ForbiddenError({ message: "Session not found." });
  }
}

export function sessionIdFromPath(pathname: string) {
  const session = /^\/eve\/v1\/session\/([^/]+)/.exec(pathname)?.[1];
  if (session) return decodePathSegment(session);
  const hookToken =
    /^\/eve\/v1\/(?:callback|connections\/[^/]+\/callback(?:\/[^/]+)?)\/([^/]+)$/.exec(
      pathname
    )?.[1];
  const token = hookToken ? decodePathSegment(hookToken) : undefined;
  return token ? sessionIdFromHookToken(token) : undefined;
}

// Hook tokens are derived from the session id: `eve:session:<id>:inbox`,
// optionally inside the session-inbox envelope `eve:inbox:v1:<token>` that eve
// wraps an authorization hook in. The `<id>:auth` and `<id>:turn-control:<n>`
// shapes this used to read are gone from eve and stay unresolved, so a request
// carrying one fails closed.
function sessionIdFromHookToken(token: string) {
  const inner = /^eve:inbox:v1:(.+)$/.exec(token)?.[1] ?? token;
  return /^eve:session:([^:]+):inbox$/.exec(inner)?.[1];
}

function decodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

async function requestIdentityFromRequest(request: Request) {
  const session = await getAuthSession(request.headers);
  if (!session) return undefined;
  const phoneNumber = z.string().safeParse(session.user.phoneNumber);
  if (!phoneNumber.success) return undefined;

  return {
    phoneNumber: phoneNumber.data,
    scope: accessScopeForUser(`better-auth:${session.user.id}`),
  };
}

async function waitForSessionOwnership(scope: AccessScope, sessionId: string) {
  /* oxlint-disable eslint/no-await-in-loop -- Ownership visibility is checked by a bounded sequential retry loop. */
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await isSessionOwned(scope, sessionId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  /* oxlint-enable eslint/no-await-in-loop */
  return false;
}
