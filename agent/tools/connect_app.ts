import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import {
  connectedAppAuthorizationLifetimeMs,
  connectedApps,
  readConnectedApp,
  startConnectedAppAuthorization,
} from "@agent/lib/connected-apps/auth";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { applicationOrigin } from "@shared/environment/origin";

/** What `connect_app` reports back; the eval checks the delivery against it. */
export const connectAppResultSchema = z.discriminatedUnion("status", [
  z.object({ account: z.string().nullable(), status: z.literal("connected") }),
  z.object({
    expiresInMinutes: z.number(),
    status: z.literal("authorize"),
    url: z.string(),
  }),
  z.object({ detail: z.string(), status: z.literal("not_configured") }),
  z.object({ detail: z.string(), status: z.literal("error") }),
]);

const appNames = { notion: "Notion", slack: "Slack" } as const;

export const connectApp = defineTool({
  description:
    "Check whether the user's own Notion or Slack account is connected and, when it is not, mint the OAuth link that connects it. Call this immediately, without clarifying questions, whenever the user asks to connect, link, or give you access to Notion or Slack, or asks whether one is connected, and whenever a notion or slack tool fails because authorization is missing. The result is one of: status `connected` with the account label, meaning the task can proceed; status `authorize` with a URL that must be delivered to the user with send_message (kind `link`, or the bare URL on its own line of a message) — the link expires in 10 minutes, and once the user finishes the consent screen the app works without further setup; status `not_configured`, meaning this deployment has no connector for that app, which must be told to the user plainly and never presented as success; or status `error`, meaning the connection service did not answer just now — relay the detail and suggest trying again in a minute.",
  inputSchema: z.object({ app: z.enum(connectedApps) }),
  async execute(
    input,
    context
  ): Promise<z.infer<typeof connectAppResultSchema>> {
    const auth = context.session.auth.current;
    if (auth?.principalType !== "user") {
      throw new Error("An authenticated user is required to connect an app.");
    }
    const name = appNames[input.app];
    const retry = `${name} сейчас не отвечает, попробуй через минуту.`;
    const { userId } = scopeFromPrincipal(auth);
    const connection = await readConnectedApp(input.app, userId);
    if (connection.state === "connected") {
      return { account: connection.accountLabel, status: "connected" };
    }
    if (connection.state === "unavailable") {
      return {
        detail: `${name} на этом деплое не подключён: нужно прикрепить коннектор ${name} в Vercel Connect.`,
        status: "not_configured",
      };
    }
    if (connection.state === "error") return { detail: retry, status: "error" };

    const callbackUrl = new URL("/workspace", applicationOrigin());
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
      resolveModeValue(context, {
        interactive: { connect_app: connectApp },
      }),
  },
});
