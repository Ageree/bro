import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { googleWorkspaceAccess } from "@agent/lib/google-workspace/client";
import { resolveModeValue } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { wakeProactiveWatch } from "@db/services/proactive";
import {
  getGoogleWorkspaceAccess,
  selectGoogleWorkspaceAccess,
} from "@db/services/settings";
import { applicationOrigin } from "@shared/environment/origin";
import {
  googleWorkspaceAccessSchema,
  googleWorkspaceAuthorizationLifetimeMs,
  googleWorkspaceConfigured,
  googleWorkspaceDisconnectNotice,
  readGoogleWorkspaceConnection,
  revokeGoogleWorkspaceGrant,
  startGoogleWorkspaceAuthorization,
} from "@shared/google-workspace/connection";

/** What `connect_google` reports back; the eval checks the delivery against it. */
export const connectGoogleResultSchema = z.discriminatedUnion("status", [
  z.object({
    abilities: z.string(),
    access: googleWorkspaceAccessSchema,
    account: z.string().nullable(),
    status: z.literal("connected"),
  }),
  z.object({
    abilities: z.string(),
    access: googleWorkspaceAccessSchema,
    expiresInMinutes: z.number(),
    previousGrantRevoked: z.boolean(),
    status: z.literal("authorize"),
    url: z.string(),
  }),
  z.object({
    access: googleWorkspaceAccessSchema,
    detail: z.string(),
    status: z.literal("not_connected"),
  }),
  z.object({ notice: z.string(), status: z.literal("disconnected") }),
  z.object({ detail: z.string(), status: z.literal("not_configured") }),
  z.object({ detail: z.string(), status: z.literal("error") }),
]);

type ConnectGoogleResult = z.infer<typeof connectGoogleResultSchema>;

/**
 * What Bro may do in Google at each level, as the person should hear it. The
 * read-only level is enforced by Bro before any card, whatever the Google
 * consent screen showed, and the person is told so (EN D9: an honest scope).
 */
export const googleAccessAbilities = {
  full: "Полный доступ: Бро читает почту, календарь, контакты и Диск, сохраняет черновики и разбирает входящие (больше трёх писем за раз — через карточку). Отправляет письма, создаёт, переносит и удаляет события, правит Таблицы и Документы — каждый раз только после карточки подтверждения, где видно, что именно уйдёт. Можно сузить до «только чтение» (connect_google с access `read_only`) или отключить совсем.",
  read_only:
    "Только чтение: Бро читает почту, календарь, контакты и Диск и ничего не отправляет, не сохраняет черновиков, не архивирует и не меняет в календаре и документах. Этот запрет держит сам Бро до всякой карточки, даже если экран согласия Google показывал доступ шире. Вернуть полный доступ можно, только если человек сам попросит (connect_google с access `full`); отключить — action `disconnect`.",
} as const satisfies Record<
  z.infer<typeof googleWorkspaceAccessSchema>,
  string
>;

const notConnectedDetail =
  "Google не подключён: Бро сейчас не читает почту, календарь, контакты и Диск и ничего в них не меняет. Ссылку не выпускал; подключить — connect_google с action `connect`, он пришлёт ссылку.";

const unreachable = {
  detail: "Google сейчас не отвечает, попробуй через минуту.",
  status: "error",
} as const satisfies ConnectGoogleResult;

const revokedWithoutLink = {
  detail:
    "Старый доступ к Google уже отозван, а новую ссылку получить не удалось: сейчас Google отключён. Попробуй через минуту — пришлю ссылку на подключение.",
  status: "error",
} as const satisfies ConnectGoogleResult;

export const connectGoogle = defineTool({
  // Disconnecting and changing the level both revoke the current grant, so
  // either waits for the person; a status read, a plain check or a
  // reconnect at the same level does not.
  approval: async (ctx) =>
    ctx.toolInput?.action === "disconnect" ||
    (ctx.toolInput?.action !== "status" &&
      ctx.toolInput?.access !== undefined &&
      ctx.toolInput.access !== (await googleWorkspaceAccess(ctx)))
      ? "user-approval"
      : "not-applicable",
  description:
    "Check, connect, change, or disconnect the user's Google account (Gmail, Calendar, Contacts, Drive) for this workspace. Call this immediately, without clarifying questions, whenever the user asks to connect, link, or give you access to Gmail, Google, their mail, calendar, contacts, or Drive, asks whether their mail or Drive is connected or what you can do there, asks for read-only access or to limit or widen what you may do in Google, or asks to disconnect or revoke Google; and whenever a gmail-*, calendar-*, contacts-*, or drive-* tool fails because authorization is missing. Action `status` only reports: the connected account, the access level and `abilities` (what Bro may do at that level, to retell in your own words), or `not_connected` — it never mints a link or changes anything. `access` picks the grant: `read_only` (read mail, calendar, contacts, and Drive; never send, draft, change, or create) or `full` (also send with approval, save drafts, tidy the inbox, create events); omit it to keep the current level. The result is one of: status `connected` with the account label, access level and abilities, meaning no setup is needed and the task can proceed; status `authorize` with a URL that must be delivered to the user with send_message (kind `link`, or the bare URL on its own line of a message) — the link expires in 10 minutes, and once the user finishes the Google consent screen the tools work at that access level; when `previousGrantRevoked` is true the old grant is already gone, so say that Google is disconnected until they open the link; status `not_connected` (action `status` only) — say plainly that Google is not connected and offer the link; status `disconnected` (action `disconnect`, after the user approves) with a notice of what was revoked and deleted, what Bro keeps and where it is stored, which must be relayed plainly; status `not_configured`, meaning this deployment has no working Google setup, which must be told to the user plainly and never presented as success; or status `error`, meaning the connection service did not answer just now — relay the detail (it says when the old grant is already revoked) and suggest trying again in a minute, without claiming Google is not set up. Disconnecting and changing the access level wait for the user's approval.",
  inputSchema: z.object({
    access: googleWorkspaceAccessSchema
      .optional()
      .describe(
        "`read_only` or `full`. Omit to keep the workspace's current level."
      ),
    action: z
      .enum(["connect", "status", "disconnect"])
      .default("connect")
      .describe(
        "`connect` checks the grant and mints a link when one is needed; `status` only reports the account, level and what Bro may do there; `disconnect` revokes Bro's access to Google."
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
    const access =
      input.action === "status" ? current : (input.access ?? current);
    const connection = await readGoogleWorkspaceConnection(
      scope.userId,
      current
    );
    if (connection.state === "unavailable") {
      return {
        status: "not_configured",
        detail:
          "Google на этом деплое не настроен: Composio не принял настройки подключения Google.",
      };
    }
    if (connection.state === "error") return unreachable;
    if (input.action === "status" && connection.state === "disconnected") {
      return {
        access: current,
        detail: notConnectedDetail,
        status: "not_connected",
      };
    }
    if (connection.state === "connected" && access === current) {
      // Someone who just finished consent from the link asks whether it
      // worked; Bro's own checks, parked on the missing grant, resume now.
      try {
        await wakeProactiveWatch(scope);
      } catch (error) {
        console.warn("[proactive] could not wake the checks", {
          cause: error,
        });
      }
      return {
        abilities: googleAccessAbilities[access],
        access,
        account: connection.accountLabel,
        status: "connected",
      };
    }

    const callbackUrl = new URL(
      "/workspace?google=connected",
      applicationOrigin()
    );
    let url: string;
    let revoked = false;
    try {
      // A grant at another level goes first: Google would keep its wider
      // scopes alive under the narrower one.
      if (connection.state === "connected") {
        await revokeGoogleWorkspaceGrant(scope.userId);
        revoked = true;
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
        revoked,
      });
      return revoked ? revokedWithoutLink : unreachable;
    }
    return {
      abilities: googleAccessAbilities[access],
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
      googleWorkspaceConfigured()
        ? resolveModeValue(context, {
            interactive: { connect_google: connectGoogle },
          })
        : null,
  },
});
