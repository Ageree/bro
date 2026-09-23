import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { applicationOrigin } from "@shared/environment/origin";
import {
  googleWorkspaceAuthorizationLifetimeMs,
  readGoogleWorkspaceConnection,
  startGoogleWorkspaceAuthorization,
} from "@shared/google-workspace/connection";

/** What `connect_google` reports back; the eval checks the delivery against it. */
export const connectGoogleResultSchema = z.discriminatedUnion("status", [
  z.object({ account: z.string().nullable(), status: z.literal("connected") }),
  z.object({
    expiresInMinutes: z.number(),
    status: z.literal("authorize"),
    url: z.string(),
  }),
  z.object({ detail: z.string(), status: z.literal("not_configured") }),
  z.object({ detail: z.string(), status: z.literal("error") }),
]);

export const connectGoogle = defineTool({
  description:
    "Check whether the user's Google account (Gmail, Calendar, Contacts, Drive) is connected to this workspace and, when it is not, mint the OAuth link that connects it. Call this immediately, without clarifying questions, whenever the user asks to connect, link, or give you access to Gmail, Google, their mail, calendar, contacts, or Drive, or asks whether their mail is connected, and whenever a gmail-*, calendar-*, contacts-*, or drive-* tool fails because authorization is missing. The result is one of: status `connected` with the account label, meaning no setup is needed and the mail task can proceed; status `authorize` with a URL that must be delivered to the user with send_message (kind `link`, or the bare URL on its own line of a message) — the link expires in 10 minutes, and once the user finishes the Google consent screen the Gmail, Calendar, Contacts, and Drive tools work without further setup; status `not_configured`, meaning this deployment has no Google OAuth connector attached, which must be told to the user plainly and never presented as success; or status `error`, meaning Google's connection service did not answer just now — relay the detail and suggest trying again in a minute, without claiming Google is not set up.",
  inputSchema: z.object({}),
  async execute(
    _input,
    context
  ): Promise<z.infer<typeof connectGoogleResultSchema>> {
    const auth = context.session.auth.current;
    if (auth?.principalType !== "user") {
      throw new Error("An authenticated user is required to connect Google.");
    }
    const { userId } = scopeFromPrincipal(auth);
    const connection = await readGoogleWorkspaceConnection(userId);
    if (connection.state === "connected") {
      return { status: "connected", account: connection.accountLabel };
    }
    if (connection.state === "unavailable") {
      return {
        status: "not_configured",
        detail:
          "Google на этом деплое не подключён: нужно прикрепить Google OAuth-коннектор в Vercel.",
      };
    }
    if (connection.state === "error") {
      return {
        status: "error",
        detail: "Google сейчас не отвечает, попробуй через минуту.",
      };
    }
    const callbackUrl = new URL(
      "/workspace?google=connected",
      applicationOrigin()
    );
    let url: string;
    try {
      url = await startGoogleWorkspaceAuthorization(
        userId,
        callbackUrl.toString()
      );
    } catch (error) {
      console.warn("[google-workspace] authorization start failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        status: "error",
        detail: "Google сейчас не отвечает, попробуй через минуту.",
      };
    }
    return {
      status: "authorize",
      expiresInMinutes: googleWorkspaceAuthorizationLifetimeMs / 60_000,
      url,
    };
  },
});

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      resolveModeValue(context, {
        interactive: { connect_google: connectGoogle },
      }),
  },
});
