import { z } from "zod";
import {
  activeConnectedAccount,
  connectionLinkLifetimeMs,
  createConnectionLink,
  disconnectConnectedAccounts,
  pruneConnectedAccounts,
} from "@shared/composio/accounts";
import {
  ComposioError,
  composioConfigured,
  isTransientComposioFailure,
} from "@shared/composio/api";
import { env } from "@shared/environment";

/**
 * How much of the Google account a workspace lets Bro use. `full` lets Bro
 * send mail, save drafts, tidy the inbox, create events and edit Sheets and
 * Docs; `read_only` only reads, and every write is refused before it runs.
 */
export const googleWorkspaceAccessSchema = z.enum(["full", "read_only"]);

export type GoogleWorkspaceAccess = z.infer<typeof googleWorkspaceAccessSchema>;

/** A workspace that never chose keeps the grant it always had. */
export const defaultGoogleWorkspaceAccess: GoogleWorkspaceAccess = "full";

/**
 * The Composio toolkit whose one grant covers Gmail, Calendar, Drive,
 * Contacts, Sheets and Docs: one consent for all of Google.
 */
export const googleWorkspaceToolkit = "googlesuper";

/**
 * The Composio auth config a level connects under, or nothing when this
 * deployment has no Google set up. Composio's own Google app is approved
 * only for broad scopes (full Gmail, Calendar and Drive), so a read-only
 * level without an auth config of its own reuses the full one: its writes
 * are refused by Bro, not by Google.
 */
export function googleWorkspaceAuthConfigId(access: GoogleWorkspaceAccess) {
  if (!composioConfigured()) return undefined;
  const full = env.COMPOSIO_GOOGLE_AUTH_CONFIG_ID;
  return access === "read_only"
    ? (env.COMPOSIO_GOOGLE_READ_ONLY_AUTH_CONFIG_ID ?? full)
    : full;
}

/** Whether this deployment offers Google at all. */
export function googleWorkspaceConfigured() {
  return googleWorkspaceAuthConfigId("full") !== undefined;
}

/**
 * What disconnecting Google does, said the same way in the cabinet and in
 * chat: what is revoked and deleted, what Bro keeps and where it is stored,
 * and how to have it removed. A person who disconnects asks exactly this
 * next (RU d14, EN D9).
 */
export const googleWorkspaceDisconnectNotice =
  "Отключение отзывает доступ Бро к Google и удаляет ключ доступа из Composio, где он хранился: Бро больше не читает почту, календарь, контакты и Диск и ничего в них не меняет. В самом Google ничего не удаляется: письма, черновики и события остаются как были. У Бро остаётся то, что уже сохранено в его облаке (база Postgres в Neon, файлы в Vercel Blob): память о тебе, история чатов (в том числе пересказы писем), заказы и файлы из писем, которые он уже переслал. Память стирается по просьбе («забудь …»); историю чатов, заказы и пересланные файлы Бро сам не удаляет. Проверить, что доступа не осталось, можно в настройках аккаунта Google, раздел «Сторонние приложения и сервисы».";

/** How long a minted Google authorization link stays valid. */
export const googleWorkspaceAuthorizationLifetimeMs = connectionLinkLifetimeMs;

export interface GoogleWorkspaceConnection {
  readonly accountLabel: string | null;
  /** The access level the connection was read at. */
  readonly access: GoogleWorkspaceAccess;
  /**
   * `connected` when the person holds an active Google account at this level,
   * `disconnected` when they have not connected yet or it expired,
   * `unavailable` when the deployment has no working Composio setup for
   * Google, `error` when Composio could not answer just now and the same
   * read may succeed shortly.
   */
  readonly state: "connected" | "disconnected" | "unavailable" | "error";
}

/**
 * Reads the person's Google connection at one access level: their newest
 * active `googlesuper` account under that level's auth config. The chat
 * tools find the account the same way, so the cabinet and the tools agree.
 */
export async function readGoogleWorkspaceConnection(
  userId: string,
  access: GoogleWorkspaceAccess
): Promise<GoogleWorkspaceConnection> {
  const authConfigId = googleWorkspaceAuthConfigId(access);
  if (!authConfigId)
    return { access, accountLabel: null, state: "unavailable" };
  try {
    const account = await activeConnectedAccount(userId, {
      authConfigIds: [authConfigId],
    });
    return account
      ? { access, accountLabel: account.displayName, state: "connected" }
      : { access, accountLabel: null, state: "disconnected" };
  } catch (error) {
    if (!isTransientComposioFailure(error)) {
      console.warn("[google-workspace] Composio refused the connection read", {
        slug: error instanceof ComposioError ? error.slug : undefined,
        status: error instanceof ComposioError ? error.status : undefined,
      });
      return { access, accountLabel: null, state: "unavailable" };
    }
    console.warn("[google-workspace] connection check failed", {
      status: error instanceof ComposioError ? error.status : undefined,
    });
    return { access, accountLabel: null, state: "error" };
  }
}

/**
 * Mints the Composio link that connects Google for the person at one access
 * level and returns them to `callbackUrl` afterwards. Link attempts they
 * never finished are cleared first.
 */
export async function startGoogleWorkspaceAuthorization(
  userId: string,
  access: GoogleWorkspaceAccess,
  callbackUrl: string
) {
  const authConfigId = googleWorkspaceAuthConfigId(access);
  if (!authConfigId) {
    throw new Error("Google is not set up in Composio on this deployment.");
  }
  await pruneConnectedAccounts({
    authConfigIds: [authConfigId],
    unfinishedOnly: true,
    userId,
  }).catch((cause: unknown) => {
    // Only tidying: a leftover attempt harms nothing.
    console.warn("[google-workspace] could not clear old link attempts", {
      status: cause instanceof ComposioError ? cause.status : undefined,
    });
  });
  const link = await createConnectionLink({
    authConfigId,
    callbackUrl,
    userId,
  });
  return link.url;
}

/**
 * Revokes the person's Google grant and deletes every Google account they
 * hold in Composio, whatever its level, so nothing Bro can reach is left.
 * Switching the access level goes through here too before the new link.
 */
export async function revokeGoogleWorkspaceGrant(userId: string) {
  await disconnectConnectedAccounts({
    toolkits: [googleWorkspaceToolkit],
    userId,
  });
}
