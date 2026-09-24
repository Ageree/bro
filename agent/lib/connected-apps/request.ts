import type { ToolContext } from "eve/tools";
import { composioProxy } from "@agent/lib/composio/proxy";
import { isMissingConnectedAccount } from "@shared/composio/api";
import type { ConnectedApp } from "@shared/composio/catalog";
import { connectedAppAuth, connectedAppAuthKey } from "./auth";

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
