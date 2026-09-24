import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { composioConfigured } from "@shared/composio/api";
import {
  connectedAppNames,
  connectedAppSchema,
} from "@shared/composio/catalog";
import {
  connectedAppAuthorizationLifetimeMs,
  connectedAppConfigured,
  disconnectConnectedApp,
  readConnectedApp,
  startConnectedAppAuthorization,
} from "@shared/composio/connected-apps";
import { applicationOrigin } from "@shared/environment/origin";

/** What `connect_app` reports back; the eval checks the delivery against it. */
export const connectAppResultSchema = z.discriminatedUnion("status", [
  z.object({ account: z.string().nullable(), status: z.literal("connected") }),
  z.object({
    expiresInMinutes: z.number(),
    status: z.literal("authorize"),
    url: z.string(),
  }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ detail: z.string(), status: z.literal("not_configured") }),
  z.object({ detail: z.string(), status: z.literal("error") }),
]);

type ConnectAppResult = z.infer<typeof connectAppResultSchema>;

export const connectApp = defineTool({
  // Disconnecting revokes the person's grant, so it waits for them.
  approval: (ctx) =>
    ctx.toolInput?.action === "disconnect" ? "user-approval" : "not-applicable",
  description:
    "Check, connect, or disconnect one of the person's own apps other than Google: Notion, Slack, Todoist, Trello, Linear, GitHub, Asana, ClickUp, Airtable, Dropbox, Zoom, Discord, HubSpot, Figma, Miro, Outlook, or Calendly. Call this immediately, without clarifying questions, whenever the person asks to connect, link, or give you access to one of them, asks whether one is connected, or asks to disconnect it; and whenever a tool for that app fails because authorization is missing. The result is one of: status `connected` with the account label, meaning the task can proceed; status `authorize` with a URL that must be delivered to the person with send_message (kind `link`, or the bare URL on its own line of a message) — the link expires in 10 minutes, and once the person finishes the consent screen the app works without further setup; status `disconnected` (action `disconnect`, after the person approves), meaning Bro no longer reaches the app; status `not_configured`, meaning this deployment cannot connect that app, which must be told to the person plainly and never presented as success; or status `error`, meaning the connection service did not answer just now — relay the detail and suggest trying again in a minute.",
  inputSchema: z.object({
    action: z
      .enum(["connect", "disconnect"])
      .default("connect")
      .describe(
        "`connect` checks the connection and mints a link when one is needed; `disconnect` revokes Bro's access to the app."
      ),
    app: connectedAppSchema,
  }),
  async execute(input, context): Promise<ConnectAppResult> {
    const auth = context.session.auth.current;
    if (auth?.principalType !== "user") {
      throw new Error("An authenticated user is required to connect an app.");
    }
    const name = connectedAppNames[input.app];
    const retry = `${name} сейчас не отвечает, попробуй через минуту.`;
    const { userId } = scopeFromPrincipal(auth);
    if (!connectedAppConfigured(input.app)) {
      return {
        detail: `${name} на этом деплое не подключается: для него не настроено подключение через Composio.`,
        status: "not_configured",
      };
    }
    if (input.action === "disconnect") {
      try {
        await disconnectConnectedApp(input.app, userId);
      } catch (error) {
        console.warn("[connected-apps] disconnect failed", {
          app: input.app,
          message: error instanceof Error ? error.message : String(error),
        });
        return { detail: retry, status: "error" };
      }
      return { status: "disconnected" };
    }
    const connection = await readConnectedApp(input.app, userId);
    if (connection.state === "connected") {
      return { account: connection.accountLabel, status: "connected" };
    }
    if (connection.state === "unavailable") {
      return {
        detail: `${name} на этом деплое не подключается: Composio не принял настройки подключения.`,
        status: "not_configured",
      };
    }
    if (connection.state === "error") return { detail: retry, status: "error" };

    const callbackUrl = new URL(
      `/workspace?app=${input.app}`,
      applicationOrigin()
    );
    try {
      const url = await startConnectedAppAuthorization(
        input.app,
        userId,
        callbackUrl.toString()
      );
      return {
        expiresInMinutes: connectedAppAuthorizationLifetimeMs / 60_000,
        status: "authorize",
        url,
      };
    } catch (error) {
      console.warn("[connected-apps] authorization start failed", {
        app: input.app,
        message: error instanceof Error ? error.message : String(error),
      });
      return { detail: retry, status: "error" };
    }
  },
});

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      composioConfigured()
        ? resolveModeValue(context, {
            interactive: { connect_app: connectApp },
          })
        : null,
  },
});
