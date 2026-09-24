import { setTimeout } from "node:timers/promises";
import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  type ConnectionPrincipal,
  defineInteractiveAuthorization,
} from "eve/connections";
import {
  type ConnectedAccount,
  createConnectionLink,
  listConnectedAccounts,
  pruneConnectedAccounts,
} from "@shared/composio/accounts";

/** Where the person's accounts for one integration live in Composio. */
interface ComposioAccounts {
  /** The auth config a new account is made under. */
  readonly authConfigId: () => Promise<string | undefined>;
  /**
   * Which of the person's accounts count. Google counts only accounts made
   * under its level's auth config; an app counts any account of its toolkit.
   */
  readonly filter: () => Promise<
    | { readonly authConfigIds: readonly string[] }
    | { readonly toolkits: readonly string[] }
    | undefined
  >;
}

/**
 * The Composio user a connection principal acts as: the Bro user id, the
 * same `user_id` the cabinet and the chat tools connect under.
 */
function composioUserId(principal: ConnectionPrincipal) {
  if (principal.type !== "user") {
    throw new Error(
      "A Composio connection requires an authenticated Bro user."
    );
  }
  return principal.id;
}

async function activeAccounts(
  userId: string,
  accounts: ComposioAccounts
): Promise<readonly ConnectedAccount[]> {
  const filter = await accounts.filter();
  if (!filter) return [];
  return listConnectedAccounts({ ...filter, statuses: ["ACTIVE"], userId });
}

/** Tries after a callback before an account still settling counts as absent. */
const activationChecksMs = [0, 1_000, 2_000] as const;

/**
 * eve's interactive authorization for one Composio integration. The "token"
 * eve caches for a tool is the person's connected account id, never a
 * provider credential: the grant stays in Composio, and every call goes out
 * through Composio's proxy or tool execution with that id. Without an active
 * account the turn parks on a sign-in card holding a Composio Connect Link
 * that returns to eve's callback, and resumes once the account is active.
 */
export function composioAuthorization(options: {
  readonly accounts: ComposioAccounts;
  /** eve's auth-flow key: its callback URL, cache and pending sign-in. */
  readonly authKey: string;
  readonly displayName: string;
  /** Runs once the person has connected, before the turn resumes. */
  readonly onConnected?: (principal: ConnectionPrincipal) => Promise<void>;
}) {
  const { accounts, authKey, displayName } = options;
  return defineInteractiveAuthorization<{ connectedAccountId: string }>({
    displayName,
    async getToken({ principal }) {
      const [account] = await activeAccounts(
        composioUserId(principal),
        accounts
      );
      if (!account) throw new ConnectionAuthorizationRequiredError(authKey);
      return { token: account.id };
    },
    async startAuthorization({ callbackUrl, principal }) {
      const authConfigId = await accounts.authConfigId();
      if (!authConfigId) {
        throw new ConnectionAuthorizationFailedError(authKey, {
          reason: "not_configured",
          retryable: false,
        });
      }
      const link = await createConnectionLink({
        authConfigId,
        callbackUrl,
        userId: composioUserId(principal),
      });
      return {
        challenge: { displayName, expiresAt: link.expiresAt, url: link.url },
        resume: { connectedAccountId: link.connectedAccountId },
      };
    },
    async completeAuthorization({ callback, principal, resume }) {
      // Composio appends `status` and the account id; only the account this
      // flow minted, found active among the person's own, counts.
      const userId = composioUserId(principal);
      const expected = resume?.connectedAccountId;
      const activated =
        callback.params.status !== "failed" && expected
          ? await activatedAccount(userId, accounts, expected)
          : undefined;
      if (activated) {
        await tidyAfterConnect(userId, accounts, activated.id);
        await options.onConnected?.(principal);
        return { token: activated.id };
      }
      throw new ConnectionAuthorizationFailedError(authKey, {
        reason:
          callback.params.status === "failed" ? "access_denied" : "inactive",
        retryable: true,
      });
    },
  });
}

/**
 * The account a flow minted, once Composio lists it active among the
 * person's own; a callback can arrive a moment before the account settles.
 */
async function activatedAccount(
  userId: string,
  accounts: ComposioAccounts,
  expectedId: string
) {
  for (const delay of activationChecksMs) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each check waits for the one before it.
    if (delay > 0) await setTimeout(delay);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential by design.
    const active = await activeAccounts(userId, accounts);
    const account = active.find((item) => item.id === expectedId);
    if (account) return account;
  }
  return undefined;
}

/**
 * Deletes the person's other accounts for the integration once a new one is
 * active, so the tools and the cabinet see one connection. Only tidying: the
 * new account works either way.
 */
async function tidyAfterConnect(
  userId: string,
  accounts: ComposioAccounts,
  keepId: string
) {
  try {
    const filter = await accounts.filter();
    if (filter) await pruneConnectedAccounts({ ...filter, keepId, userId });
  } catch (error) {
    console.warn("[composio] could not remove older accounts", {
      cause: error,
    });
  }
}
