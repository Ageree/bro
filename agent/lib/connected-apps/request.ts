import { isConnectionAuthorizationRequiredError } from "eve/connections";
import type { SessionContext } from "eve/context";
import type { ToolContext } from "eve/tools";
import type { ApprovalStatus } from "eve/tools/approval";
import { composioProxy } from "@agent/lib/composio/proxy";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { activeConnectedAccount } from "@shared/composio/accounts";
import { isMissingConnectedAccount } from "@shared/composio/api";
import { type ConnectedApp, connectedAppNames } from "@shared/composio/catalog";
import { connectedAppAuth, connectedAppAuthKey } from "./auth";

/**
 * Whether a tool call stopped on the app's sign-in: eve's `getToken` and
 * `requireAuth` throw an error the tool runner turns into the sign-in card,
 * which parks the whole turn until the person connects.
 */
function signInRequired(cause: unknown) {
  return (
    cause instanceof Error &&
    (cause.name === "ScopedAuthorizationRequiredError" ||
      isConnectionAuthorizationRequiredError(cause) ||
      isConnectionAuthorizationRequiredError(cause.cause))
  );
}

/** What the model hears for an app the person has not connected nor named. */
function notConnectedNote(app: ConnectedApp) {
  const name = connectedAppNames[app];
  return `${name} is not connected for this person, and they did not ask for ${name} in this message. Nothing was done in ${name}. Do not ask them to connect it and do not wait for it: find the information another way you have (mail, contacts, calendar), or write to someone the way contacts-search lists for them (\`canMessageVia\`: email through gmail-send). You cannot send an SMS or a Telegram or WhatsApp message, so do not offer those: give the ready text for the person to forward, and say plainly which part you could not do.`;
}

/**
 * Runs one call of an app's tool. When the person has not connected the app,
 * or its grant is gone, and did not name the app in their message this turn
 * (`askToConnect`), the call answers `not_connected` instead of parking the
 * turn on a sign-in card nobody asked for: the model reaches the person
 * another way and the rest of the request goes on.
 */
export async function unlessUnconnected<T>(
  app: ConnectedApp,
  askToConnect: boolean,
  call: () => Promise<T>
) {
  try {
    return await call();
  } catch (error) {
    if (askToConnect || !signInRequired(error)) throw error;
    return { note: notConnectedNote(app), status: "not_connected" as const };
  }
}

/**
 * The approval for a call of an app's tool that would show a card, when the
 * person has not connected the app and did not name it this turn: refused
 * at once, since the card would park the turn only to lead to a sign-in
 * card. Undefined when the card may go ahead — the app was named, the
 * person has an account, or Composio could not say.
 */
export async function unconnectedAppRefusal(
  app: ConnectedApp,
  askToConnect: boolean,
  context: Pick<SessionContext, "session">
): Promise<ApprovalStatus | undefined> {
  if (askToConnect) return undefined;
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  if (caller?.principalType !== "user") return undefined;
  try {
    const account = await activeConnectedAccount(
      scopeFromPrincipal(caller).userId,
      { toolkits: [app] }
    );
    if (account) return undefined;
  } catch {
    return undefined;
  }
  return { reason: notConnectedNote(app), type: "denied" };
}

/**
 * Shows the app's sign-in card again, for a grant the app itself says is
 * gone (Slack answers a revoked token with 200 and `ok: false`).
 */
export function requireAppAuth(ctx: ToolContext, app: ConnectedApp): never {
  return ctx.requireAuth(connectedAppAuth(app), {
    authKey: connectedAppAuthKey(app),
  });
}

/**
 * One request to an app's own API as the person, through Composio's proxy.
 * The account comes from the app's eve authorization, so a person who has not
 * connected gets the sign-in card; an account Composio no longer has, or a
 * 401 from the app, shows it again. Any other answer is the app's, status
 * and all, for the caller to read.
 */
export async function appRequest(
  ctx: ToolContext,
  app: ConnectedApp,
  request: Omit<Parameters<typeof composioProxy>[1], "signal">
) {
  const { token } = await ctx.getToken(connectedAppAuth(app), {
    authKey: connectedAppAuthKey(app),
  });
  try {
    const response = await composioProxy(token, {
      ...request,
      signal: ctx.abortSignal,
    });
    if (response.status === 401) requireAppAuth(ctx, app);
    return response;
  } catch (error) {
    if (isMissingConnectedAccount(error)) requireAppAuth(ctx, app);
    throw error;
  }
}
