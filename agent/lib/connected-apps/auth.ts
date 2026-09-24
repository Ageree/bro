import { composioAuthorization } from "@agent/lib/composio/authorization";
import { type ConnectedApp, connectedAppNames } from "@shared/composio/catalog";
import {
  connectedAppAuthConfigId,
  connectedAppConfigured,
} from "@shared/composio/connected-apps";

function createConnectedAppAuth(app: ConnectedApp) {
  return composioAuthorization({
    accounts: {
      authConfigId: async () => connectedAppAuthConfigId(app),
      // Any active account of the app counts, whichever auth config made it:
      // the cabinet and the chat read the connection the same way.
      filter: async () =>
        connectedAppConfigured(app) ? { toolkits: [app] } : undefined,
    },
    authKey: connectedAppAuthKey(app),
    displayName: connectedAppNames[app],
  });
}

/** eve's auth-flow key for one app: its sign-in callback and cached account. */
export function connectedAppAuthKey(app: ConnectedApp) {
  return `composio-${app}`;
}

const connectedAppAuths = new Map<
  ConnectedApp,
  ReturnType<typeof createConnectedAppAuth>
>();

/**
 * The eve authorization for one app, backed by the person's Composio
 * account for it. Every tool that acts in the app shares it, so the person
 * connects an app once for all of them.
 */
export function connectedAppAuth(app: ConnectedApp) {
  const known = connectedAppAuths.get(app);
  if (known) return known;
  const created = createConnectedAppAuth(app);
  connectedAppAuths.set(app, created);
  return created;
}
