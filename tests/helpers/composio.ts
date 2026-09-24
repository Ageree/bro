import type { ToolContext } from "eve/tools";
import { vi } from "vitest";
import { z } from "zod";
import { accessScopeForUser } from "@shared/identity/access-scope";

/** A connected account the fake Composio project holds. */
interface FakeAccount {
  readonly authConfigId: string;
  readonly createdAt: string;
  readonly displayName?: string;
  readonly id: string;
  status: string;
  readonly toolkit: string;
  readonly userId: string;
}

/** One request Bro sent through the proxy, as the upstream API would see it. */
export interface ProxiedRequest {
  readonly body: unknown;
  readonly connectedAccountId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly url: URL;
}

/** What the upstream API answers a proxied request with. */
export interface ProxiedAnswer {
  readonly binary?: {
    readonly bytes: Uint8Array;
    readonly contentType: string;
  };
  readonly data?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly status?: number;
}

/** A Composio tool the fake project lists and runs. */
interface FakeTool {
  readonly description?: string;
  readonly input_parameters?: unknown;
  readonly is_deprecated?: boolean;
  readonly name?: string;
  readonly slug: string;
  readonly tags?: readonly string[];
  readonly toolkit: string;
}

const proxyBodySchema = z.object({
  body: z.unknown(),
  connected_account_id: z.string(),
  endpoint: z.string(),
  method: z.string(),
  parameters: z
    .array(z.object({ name: z.string(), type: z.string(), value: z.string() }))
    .default([]),
});

const linkBodySchema = z.object({
  auth_config_id: z.string(),
  callback_url: z.string(),
  user_id: z.string(),
});

const executeBodySchema = z.object({
  arguments: z.record(z.string(), z.unknown()).default({}),
  connected_account_id: z.string(),
  user_id: z.string(),
});

const apiPrefix = "/api/v3.1";

function json(status: number, text: string) {
  return new Response(text, {
    headers: { "content-type": "application/json" },
    status,
  });
}

function composioError(status: number, slug: string, message: string) {
  return json(
    status,
    JSON.stringify({ error: { code: status, message, slug, status } })
  );
}

function wireAccount(account: FakeAccount) {
  return {
    auth_config: { id: account.authConfigId },
    created_at: account.createdAt,
    id: account.id,
    state: {
      authScheme: "OAUTH2",
      val: { displayName: account.displayName, status: account.status },
    },
    status: account.status,
    toolkit: { slug: account.toolkit },
    user_id: account.userId,
  };
}

/** Whether a list filter lets the value through; no filter lets all. */
function matches(values: readonly string[], value: string) {
  return values.length === 0 || values.includes(value);
}

function wireTool(tool: FakeTool) {
  return {
    description: tool.description ?? "",
    input_parameters: tool.input_parameters ?? {},
    is_deprecated: tool.is_deprecated ?? false,
    name: tool.name ?? tool.slug,
    slug: tool.slug,
    tags: tool.tags ?? [],
    toolkit: { slug: tool.toolkit },
  };
}

/**
 * A fake Composio project behind a stubbed `fetch`: connected accounts,
 * Connect Links, the proxy, and tools. Tests mock Composio at its HTTP
 * boundary with it, the way Bro reaches the real one.
 */
export function fakeComposio() {
  const accounts: FakeAccount[] = [];
  const authConfigs: { id: string; status: string; toolkit: string }[] = [];
  const tools: FakeTool[] = [];
  const downloads = new Map<string, ArrayBuffer>();
  const requests: { method: string; path: string; body: unknown }[] = [];
  const proxy = vi.fn<
    (request: ProxiedRequest) => ProxiedAnswer | Promise<ProxiedAnswer>
  >(() => ({ data: {}, status: 200 }));
  const execute = vi.fn<
    (
      slug: string,
      body: z.infer<typeof executeBodySchema>
    ) => { data?: unknown; error?: string | null; successful: boolean }
  >(() => ({ data: {}, successful: true }));
  let sequence = 0;

  async function route(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const text = z.string().safeParse(init?.body).data;
    const body: unknown = text === undefined ? undefined : JSON.parse(text);
    const download = downloads.get(url.toString());
    if (download) return new Response(download);
    if (url.host !== "backend.composio.dev") {
      throw new TypeError(`Unexpected request to ${url.toString()}`);
    }
    const path = url.pathname.slice(apiPrefix.length);
    requests.push({ body, method, path });

    if (path === "/connected_accounts" && method === "GET") {
      const listed = (name: string) => url.searchParams.getAll(name);
      return json(
        200,
        JSON.stringify({
          items: accounts
            .filter(
              (account) =>
                matches(listed("user_ids"), account.userId) &&
                matches(listed("toolkit_slugs"), account.toolkit) &&
                matches(listed("auth_config_ids"), account.authConfigId) &&
                matches(listed("statuses"), account.status)
            )
            .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map(wireAccount),
        })
      );
    }
    if (path === "/connected_accounts/link" && method === "POST") {
      const link = linkBodySchema.parse(body);
      sequence += 1;
      const authConfig = authConfigs.find(
        (config) => config.id === link.auth_config_id
      );
      const account: FakeAccount = {
        authConfigId: link.auth_config_id,
        createdAt: new Date(Date.UTC(2026, 8, 24, 12, sequence)).toISOString(),
        id: `ca_link_${String(sequence)}`,
        status: "INITIATED",
        toolkit: authConfig?.toolkit ?? "googlesuper",
        userId: link.user_id,
      };
      accounts.push(account);
      return json(
        201,
        JSON.stringify({
          connected_account_id: account.id,
          expires_at: "2026-09-24T12:10:00.000Z",
          link_token: `lk_${String(sequence)}`,
          redirect_url: `https://connect.composio.dev/link/lk_${String(sequence)}`,
        })
      );
    }
    const accountPath = /^\/connected_accounts\/([^/]+)(\/revoke)?$/u.exec(
      path
    );
    if (accountPath) {
      const id = decodeURIComponent(accountPath[1] ?? "");
      const index = accounts.findIndex((account) => account.id === id);
      const account = accounts[index];
      if (!account) {
        return composioError(404, "ConnectedAccount_ResourceNotFound", "Gone");
      }
      if (accountPath[2] && method === "POST") {
        account.status = "REVOKED";
        return json(
          200,
          JSON.stringify({ connected_account: { id, status: "REVOKED" } })
        );
      }
      if (method === "DELETE") {
        accounts.splice(index, 1);
        return json(200, JSON.stringify({ success: true }));
      }
    }
    if (path === "/tools/execute/proxy" && method === "POST") {
      const request = proxyBodySchema.parse(body);
      if (
        !accounts.some(
          (account) =>
            account.id === request.connected_account_id &&
            account.status === "ACTIVE"
        )
      ) {
        return composioError(
          404,
          "ConnectedAccount_ResourceNotFound",
          `Connected account "${request.connected_account_id}" not found`
        );
      }
      const answer = await proxy({
        body: request.body,
        connectedAccountId: request.connected_account_id,
        headers: Object.fromEntries(
          request.parameters
            .filter((parameter) => parameter.type === "header")
            .map((parameter) => [parameter.name, parameter.value])
        ),
        method: request.method,
        url: new URL(request.endpoint),
      });
      if (answer.binary) {
        sequence += 1;
        const downloadUrl = `https://storage.example.com/proxy/${String(sequence)}`;
        downloads.set(downloadUrl, new Uint8Array(answer.binary.bytes).buffer);
        return json(
          200,
          JSON.stringify({
            binary_data: {
              content_type: answer.binary.contentType,
              size: answer.binary.bytes.byteLength,
              url: downloadUrl,
            },
            data: null,
            headers: answer.headers ?? {},
            status: answer.status ?? 200,
          })
        );
      }
      return json(
        200,
        JSON.stringify({
          data: answer.data ?? null,
          headers: answer.headers ?? {},
          status: answer.status ?? 200,
        })
      );
    }
    const executePath = /^\/tools\/execute\/([A-Z0-9_]+)$/u.exec(path);
    if (executePath && method === "POST") {
      const call = executeBodySchema.parse(body);
      return json(
        200,
        JSON.stringify({
          ...execute(executePath[1] ?? "", call),
          log_id: "log_1",
        })
      );
    }
    const toolPath = /^\/tools\/([A-Z0-9_]+)$/u.exec(path);
    if (toolPath && method === "GET") {
      const tool = tools.find((item) => item.slug === toolPath[1]);
      return tool
        ? json(200, JSON.stringify(wireTool(tool)))
        : composioError(404, "Tool_NotFound", "No such tool");
    }
    if (path === "/tools" && method === "GET") {
      const toolkit = url.searchParams.get("toolkit_slug");
      return json(
        200,
        JSON.stringify({
          items: tools.filter((tool) => tool.toolkit === toolkit).map(wireTool),
        })
      );
    }
    if (path === "/auth_configs" && method === "GET") {
      const toolkit = url.searchParams.get("toolkit_slug");
      return json(
        200,
        JSON.stringify({
          items: authConfigs
            .filter((config) => config.toolkit === toolkit)
            .map((config) => ({
              id: config.id,
              is_composio_managed: true,
              status: config.status,
            })),
        })
      );
    }
    if (path === "/auth_configs" && method === "POST") {
      const created = z
        .object({ toolkit: z.object({ slug: z.string() }) })
        .parse(body);
      sequence += 1;
      const id = `ac_created_${String(sequence)}`;
      authConfigs.push({
        id,
        status: "ENABLED",
        toolkit: created.toolkit.slug,
      });
      return json(201, JSON.stringify({ auth_config: { id } }));
    }
    return composioError(404, "Route_NotFound", `${method} ${path}`);
  }

  const fetchMock = vi.fn<typeof fetch>(route);
  vi.stubGlobal("fetch", fetchMock);

  return {
    accounts,
    authConfigs,
    execute,
    fetch: fetchMock,
    proxy,
    requests,
    tools,
    /** Adds an account the person already connected. */
    connect(account: Partial<FakeAccount> & Pick<FakeAccount, "toolkit">) {
      sequence += 1;
      const connected: FakeAccount = {
        authConfigId: "ac_google_full",
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, sequence)).toISOString(),
        id: `ca_${String(sequence)}`,
        status: "ACTIVE",
        userId: "better-auth:user-1",
        ...account,
      };
      accounts.push(connected);
      return connected;
    },
  };
}

export type FakeComposio = ReturnType<typeof fakeComposio>;

/**
 * A tool context whose eve authorization hands back the connected account
 * id, as eve does once the person has connected. `requireAuth` throws like
 * eve's does when it starts the sign-in again.
 */
export function composioToolContext(
  connectedAccountId: string,
  options: { readonly userId?: string; readonly toolName?: string } = {}
) {
  const userId = options.userId ?? "better-auth:user-1";
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    getToken: vi.fn<ToolContext["getToken"]>(async () => ({
      token: connectedAccountId,
    })),
    requireAuth: vi.fn<ToolContext["requireAuth"]>(() => {
      throw new Error("authorization required");
    }),
    session: {
      auth: {
        current: {
          attributes: {
            workspaceId: accessScopeForUser(userId).workspaceId,
          },
          authenticator: "photon-imessage",
          principalId: userId,
          principalType: "user" as const,
        },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: options.toolName ?? "test",
  } satisfies ToolContext;
}
