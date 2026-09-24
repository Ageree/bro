import { z } from "zod";
import { ComposioError, composioRequest } from "./api";

/**
 * A person's connected account as Bro reads it. Composio keys accounts by
 * `user_id`, which is the Bro user id (`better-auth:<id>`). Composio redacts
 * credential fields in account reads, and this shape keeps none of them: the
 * provider's grant never leaves Composio. `displayName` is the provider-side
 * identity Composio fills in once the account is active, such as the Google
 * address.
 */
const connectedAccountSchema = z
  .object({
    auth_config: z.object({ id: z.string() }),
    created_at: z.string(),
    id: z.string(),
    state: z
      .object({
        val: z.object({ displayName: z.string().optional() }).optional(),
      })
      .optional(),
    status: z.string(),
    toolkit: z.object({ slug: z.string() }),
  })
  .transform((account) => ({
    authConfigId: account.auth_config.id,
    createdAt: account.created_at,
    displayName: account.state?.val?.displayName ?? null,
    id: account.id,
    status: account.status,
    toolkit: account.toolkit.slug,
  }));

export type ConnectedAccount = z.output<typeof connectedAccountSchema>;

const accountPageSchema = z.object({ items: z.array(connectedAccountSchema) });

/** Accounts one person holds, newest first. */
export async function listConnectedAccounts(
  filter: {
    readonly authConfigIds?: readonly string[];
    readonly statuses?: readonly string[];
    readonly toolkits?: readonly string[];
    readonly userId: string;
  },
  signal?: AbortSignal
) {
  const { items } = await composioRequest(
    accountPageSchema,
    "/connected_accounts",
    {
      query: {
        auth_config_ids: filter.authConfigIds,
        limit: 50,
        order_by: "created_at",
        order_direction: "desc",
        statuses: filter.statuses,
        toolkit_slugs: filter.toolkits,
        user_ids: [filter.userId],
      },
      signal,
    }
  );
  return items;
}

/**
 * The person's newest active account under one of the auth configs or
 * toolkits, or nothing when they have not connected (or the grant expired).
 */
export async function activeConnectedAccount(
  userId: string,
  filter: {
    readonly authConfigIds?: readonly string[];
    readonly toolkits?: readonly string[];
  },
  signal?: AbortSignal
): Promise<ConnectedAccount | undefined> {
  const [account] = await listConnectedAccounts(
    { ...filter, statuses: ["ACTIVE"], userId },
    signal
  );
  return account;
}

/** How long a Composio Connect Link stays open. */
export const connectionLinkLifetimeMs = 10 * 60_000;

const connectionLinkSchema = z
  .object({
    connected_account_id: z.string(),
    expires_at: z.string(),
    redirect_url: z.url(),
  })
  .transform((link) => ({
    connectedAccountId: link.connected_account_id,
    expiresAt: link.expires_at,
    url: link.redirect_url,
  }));

/**
 * Mints the hosted Composio Connect Link that connects one account for the
 * person under an auth config. After consent Composio sends the browser to
 * `callbackUrl` with `status` and `connected_account_id` appended.
 */
export async function createConnectionLink(input: {
  readonly authConfigId: string;
  readonly callbackUrl: string;
  readonly userId: string;
}) {
  return composioRequest(connectionLinkSchema, "/connected_accounts/link", {
    body: {
      auth_config_id: input.authConfigId,
      callback_url: input.callbackUrl,
      user_id: input.userId,
    },
    method: "POST",
  });
}

/** Statuses of an account that never finished or no longer works. */
const unfinishedStatuses = ["INITIALIZING", "INITIATED", "FAILED", "EXPIRED"];

/**
 * Deletes the person's accounts under the auth configs or toolkits other
 * than `keepId`,
 * without touching the provider-side grant: after a new consent the old
 * account's grant may be the very one the new account uses, and revoking it
 * would disconnect the person again. With `unfinishedOnly` it leaves every
 * active account in place and clears only abandoned link attempts.
 */
export async function pruneConnectedAccounts(input: {
  readonly authConfigIds?: readonly string[];
  readonly keepId?: string;
  readonly toolkits?: readonly string[];
  readonly unfinishedOnly?: boolean;
  readonly userId: string;
}) {
  const accounts = await listConnectedAccounts({
    authConfigIds: input.authConfigIds,
    statuses: input.unfinishedOnly ? unfinishedStatuses : undefined,
    toolkits: input.toolkits,
    userId: input.userId,
  });
  await Promise.all(
    accounts
      .filter((account) => account.id !== input.keepId)
      .map((account) => deleteConnectedAccount(account.id))
  );
}

/**
 * Disconnects the person from a toolkit: every account they hold for it is
 * revoked at the provider where Composio can, then deleted. Revoking comes
 * first and waits, so a link minted right after cannot race a revocation
 * still running in the background.
 */
export async function disconnectConnectedAccounts(input: {
  readonly toolkits: readonly string[];
  readonly userId: string;
}) {
  const accounts = await listConnectedAccounts({
    toolkits: input.toolkits,
    userId: input.userId,
  });
  await Promise.all(
    accounts.map(async (account) => {
      if (account.status === "ACTIVE") await revokeConnectedAccount(account.id);
      await deleteConnectedAccount(account.id);
    })
  );
  return accounts.length;
}

/**
 * Revokes one account's grant at the provider. Composio answers 400 for a
 * provider it cannot revoke at (Notion) and 409 for an account past
 * revoking; either way deleting the account is what is left to do.
 */
async function revokeConnectedAccount(id: string) {
  try {
    await composioRequest(
      z.unknown(),
      `/connected_accounts/${encodeURIComponent(id)}/revoke`,
      { method: "POST" }
    );
  } catch (error) {
    if (
      error instanceof ComposioError &&
      (error.status === 400 || error.status === 409)
    ) {
      return;
    }
    throw error;
  }
}

/** Deletes one account; one already gone counts as deleted. */
async function deleteConnectedAccount(id: string) {
  try {
    await composioRequest(
      z.unknown(),
      `/connected_accounts/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
  } catch (error) {
    if (error instanceof ComposioError && error.status === 404) return;
    throw error;
  }
}
