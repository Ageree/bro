import { z } from "zod";
import { withRetry } from "../retry.ts";

/**
 * The tester's Google account as Bro reaches it: a Composio connected
 * account of the `googlesuper` toolkit (Gmail, Calendar, Drive, Contacts)
 * whose `user_id` is the Bro user. The driver never sees its OAuth tokens:
 * every Google call goes through Composio's proxy, which signs it, and only
 * the fields read below are kept from Composio's answers.
 */

const composioApi = "https://backend.composio.dev/api/v3";
const googleToolkit = "googlesuper";

const accountsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().min(1),
      status: z.string(),
      user_id: z.string(),
    })
  ),
});

/**
 * One Composio call, sent again after a dropped connection only when that
 * cannot write twice (`retry.ts`): a read, or a request that never left.
 */
async function composioFetch(
  apiKey: string,
  path: string,
  init: {
    readonly body?: string;
    readonly method: "GET" | "POST";
    /** Changes nothing: a GET, or a Google GET through the proxy. */
    readonly read: boolean;
  }
) {
  const headers = new Headers({ "x-api-key": apiKey });
  if (init.body) headers.set("content-type", "application/json");
  const route = path.split("?")[0] ?? path;
  return await withRetry(
    { idempotent: init.read, label: `Composio ${init.method} ${route}` },
    async () => {
      const response = await fetch(`${composioApi}${path}`, {
        body: init.body,
        headers,
        method: init.method,
      });
      if (!response.ok) {
        // Composio's errors name the problem; they carry no credentials.
        const detail = (await response.text()).slice(0, 300);
        throw new Error(
          `Composio ${init.method} ${route} answered ${String(response.status)}: ${detail}`
        );
      }
      const json: unknown = await response.json();
      return json;
    }
  );
}

/**
 * The tester's active Google connection. The Bro user id is looked up both
 * bare and as the `better-auth:<id>` principal the app scopes by, since
 * either may be the `user_id` the connection was made under.
 */
export async function findGoogleAccount(apiKey: string, userId: string) {
  const userIds = [userId, `better-auth:${userId}`];
  const query = new URLSearchParams({
    statuses: "ACTIVE",
    toolkit_slugs: googleToolkit,
    user_ids: userIds.join(","),
  });
  const { items } = accountsSchema.parse(
    await composioFetch(apiKey, `/connected_accounts?${query.toString()}`, {
      method: "GET",
      read: true,
    })
  );
  const active = items.filter((item) => item.status === "ACTIVE");
  const [account, ...others] = active;
  if (!account) {
    throw new Error(
      `No ACTIVE ${googleToolkit} connection in Composio for Bro user ${userId}: connect Google in Bro first, or pass --account ca_….`
    );
  }
  if (others.length > 0) {
    throw new Error(
      `Several ACTIVE ${googleToolkit} connections for Bro user ${userId} (${active.map((item) => item.id).join(", ")}): pick one with --account.`
    );
  }
  return account.id;
}

/** One Google API call, as Composio's proxy takes it. */
export interface GoogleRequest {
  /** Uploaded as the request body instead of `body`. */
  readonly binary?: { readonly base64: string; readonly contentType: string };
  /** A JSON request body, sent as `JSON.stringify` writes it. */
  readonly body?: object;
  readonly method: "DELETE" | "GET" | "PATCH" | "POST";
  readonly query?: Readonly<Record<string, string>>;
  /** An absolute Google API URL. */
  readonly url: string;
}

const proxyResultSchema = z.object({
  data: z.unknown(),
  status: z.number().int(),
});

/**
 * Calls Google as `account`. Composio answers 200 whatever Google said;
 * Google's status and body come back as `status` and `data`.
 */
export function composioProxy(apiKey: string, account: string) {
  return async (request: GoogleRequest) => {
    const parameters = Object.entries(request.query ?? {}).map(
      ([name, value]) => ({ name, type: "query", value })
    );
    const result = proxyResultSchema.parse(
      await composioFetch(apiKey, "/tools/execute/proxy", {
        body: JSON.stringify({
          binary_body: request.binary
            ? {
                base64: request.binary.base64,
                content_type: request.binary.contentType,
              }
            : undefined,
          body: request.body,
          connected_account_id: account,
          endpoint: request.url,
          method: request.method,
          parameters,
        }),
        method: "POST",
        // A letter inserted or an event created twice would be a fixture twice.
        read: request.method === "GET",
      })
    );
    return { data: result.data, status: result.status };
  };
}

export type GoogleCall = ReturnType<typeof composioProxy>;
