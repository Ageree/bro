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

export const connectGoogle = defineTool({
  description:
    "Check whether the user's Google account (Gmail, Calendar, Contacts) is connected to this workspace and, when it is not, mint the OAuth link that connects it. Call this immediately, without clarifying questions, whenever the user asks to connect, link, or give you access to Gmail, Google, their mail, calendar, or contacts, or asks whether their mail is connected, and whenever a gmail-*, calendar-*, or contacts-* tool fails because authorization is missing. The result is one of: status `connected` with the account label, meaning no setup is needed and the mail task can proceed; status `authorize` with a URL that must be delivered to the user with send_message (kind `link`, or the bare URL on its own line of a message) — the link expires in 10 minutes, and once the user finishes the Google consent screen the Gmail, Calendar, and Contacts tools work without further setup; or status `not_configured`, meaning this deployment has no Google OAuth connector attached, which must be told to the user plainly and never presented as success.",
  inputSchema: z.object({}),
  async execute(_input, context) {
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
    const callbackUrl = new URL(
      "/workspace?google=connected",
      applicationOrigin()
    );
    return {
      status: "authorize",
      expiresInMinutes: googleWorkspaceAuthorizationLifetimeMs / 60_000,
      url: await startGoogleWorkspaceAuthorization(
        userId,
        callbackUrl.toString()
      ),
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
