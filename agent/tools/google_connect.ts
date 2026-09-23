import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  getGoogleWorkspaceAccess,
  selectGoogleWorkspaceAccess,
} from "@db/services/settings";
import { applicationOrigin } from "@shared/environment/origin";
import {
  googleWorkspaceAccessSchema,
  googleWorkspaceAuthorizationLifetimeMs,
  googleWorkspaceDisconnectNotice,
  readGoogleWorkspaceConnection,
  revokeGoogleWorkspaceGrant,
  startGoogleWorkspaceAuthorization,
} from "@shared/google-workspace/connection";

/** What `connect_google` reports back; the eval checks the delivery against it. */
export const connectGoogleResultSchema = z.discriminatedUnion("status", [
  z.object({
    access: googleWorkspaceAccessSchema,
    account: z.string().nullable(),
    status: z.literal("connected"),
  }),
  z.object({
    access: googleWorkspaceAccessSchema,
    expiresInMinutes: z.number(),
    previousGrantRevoked: z.boolean(),
    status: z.literal("authorize"),
    url: z.string(),
  }),
  z.object({ notice: z.string(), status: z.literal("disconnected") }),
  z.object({ detail: z.string(), status: z.literal("not_configured") }),
  z.object({ detail: z.string(), status: z.literal("error") }),
]);

type ConnectGoogleResult = z.infer<typeof connectGoogleResultSchema>;

const unreachable = {
  detail: "Google сейчас не отвечает, попробуй через минуту.",
  status: "error",
} as const satisfies ConnectGoogleResult;

export const connectGoogle = defineTool({
  approval: ({ toolInput }) =>
    toolInput?.action === "disconnect" ? "user-approval" : "not-applicable",
  description:
    "Check, connect, change, or disconnect the user's Google account (Gmail, Calendar, Contacts) for this workspace. Call this immediately, without clarifying questions, whenever the user asks to connect, link, or give you access to Gmail, Google, their mail, calendar, or contacts, asks whether their mail is connected, asks for read-only access or to limit or widen what you may do in Google, or asks to disconnect or revoke Google; and whenever a gmail-*, calendar-*, or contacts-* tool fails because authorization is missing. `access` picks the grant: `read_only` (read mail, calendar, and contacts; never send, draft, change, or create) or `full` (also send with approval, save drafts, tidy the inbox, create events); omit it to keep the current level. The result is one of: status `connected` with the account label and access level, meaning no setup is needed and the task can proceed; status `authorize` with a URL that must be delivered to the user with send_message (kind `link`, or the bare URL on its own line of a message) — the link expires in 10 minutes, and once the user finishes the Google consent screen the tools work at that access level; when `previousGrantRevoked` is true the old grant is already gone, so say that Google is disconnected until they open the link; status `disconnected` (action `disconnect`, after the user approves) with a notice of what happens to their data, which must be relayed plainly; status `not_configured`, meaning this deployment has no Google OAuth connector attached, which must be told to the user plainly and never presented as success; or status `error`, meaning Google's connection service did not answer just now — relay the detail and suggest trying again in a minute, without claiming Google is not set up.",
  inputSchema: z.object({
    access: googleWorkspaceAccessSchema
      .optional()
      .describe(
        "`read_only` or `full`. Omit to keep the workspace's current level."
      ),
    action: z
      .enum(["connect", "disconnect"])
      .default("connect")
      .describe(
        "`connect` checks the grant and mints a link when one is needed; `disconnect` revokes Bro's access to Google."
      ),
  }),
  async execute(input, context): Promise<ConnectGoogleResult> {
    const auth = context.session.auth.current;
    if (auth?.principalType !== "user") {
      throw new Error("An authenticated user is required to connect Google.");
    }
    const scope = scopeFromPrincipal(auth);
    if (input.action === "disconnect") {
      try {
        await revokeGoogleWorkspaceGrant(scope.userId);
      } catch (error) {
        console.warn("[google-workspace] revoke failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        return unreachable;
      }
      return {
        notice: googleWorkspaceDisconnectNotice,
        status: "disconnected",
      };
    }

    const current = await getGoogleWorkspaceAccess(scope);
    const access = input.access ?? current;
    const connection = await readGoogleWorkspaceConnection(
      scope.userId,
      current
    );
    if (connection.state === "unavailable") {
      return {
        status: "not_configured",
        detail:
          "Google на этом деплое не подключён: нужно прикрепить Google OAuth-коннектор в Vercel.",
      };
    }
    if (connection.state === "error") return unreachable;
    if (connection.state === "connected" && access === current) {
      return { access, account: connection.accountLabel, status: "connected" };
    }

    const callbackUrl = new URL(
      "/workspace?google=connected",
      applicationOrigin()
    );
    let url: string;
    try {
      // A grant at another level goes first: Google would keep its wider
      // scopes alive under the narrower one.
      if (connection.state === "connected") {
        await revokeGoogleWorkspaceGrant(scope.userId);
      }
      if (access !== current) await selectGoogleWorkspaceAccess(scope, access);
      url = await startGoogleWorkspaceAuthorization(
        scope.userId,
        access,
        callbackUrl.toString()
      );
    } catch (error) {
      console.warn("[google-workspace] authorization start failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return unreachable;
    }
    return {
      access,
      expiresInMinutes: googleWorkspaceAuthorizationLifetimeMs / 60_000,
      previousGrantRevoked: connection.state === "connected",
      status: "authorize",
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
