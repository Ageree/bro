import { setTimeout } from "node:timers/promises";
import type { ConnectionPrincipal } from "eve/connections";
import type { SessionContext } from "eve/context";
import type { ToolContext } from "eve/tools";
import type { ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";
import { composioAuthorization } from "@agent/lib/composio/authorization";
import { composioProxy, proxyBodyBytes } from "@agent/lib/composio/proxy";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { wakeProactiveWatch } from "@db/services/proactive";
import { getGoogleWorkspaceAccess } from "@db/services/settings";
import { ComposioError, isMissingConnectedAccount } from "@shared/composio/api";
import {
  type GoogleWorkspaceAccess,
  googleWorkspaceAuthConfigId,
  readGoogleWorkspaceConnection,
} from "@shared/google-workspace/connection";

/**
 * eve's auth-flow key per level: a pending sign-in or cached account at one
 * level is never served for the other.
 */
const googleWorkspaceAuthKeys = {
  full: "google-workspace",
  read_only: "google-workspace-read-only",
} satisfies Record<GoogleWorkspaceAccess, string>;

/**
 * The eve authorization for one Google access level: the person's active
 * `googlesuper` account under that level's Composio auth config. A person
 * who connects from the chat card never opens the cabinet, so finishing
 * consent wakes Bro's own mail and calendar checks, which a missing grant
 * had put off for hours.
 */
export function googleWorkspaceProvider(access: GoogleWorkspaceAccess) {
  return composioAuthorization({
    accounts: {
      authConfigId: async () => googleWorkspaceAuthConfigId(access),
      async filter() {
        const authConfigId = googleWorkspaceAuthConfigId(access);
        return authConfigId ? { authConfigIds: [authConfigId] } : undefined;
      },
    },
    authKey: googleWorkspaceAuthKeys[access],
    displayName: "Google",
    onConnected: wakeProactiveChecks,
  });
}

async function wakeProactiveChecks(principal: ConnectionPrincipal) {
  // eve hands over the session caller's attributes, its workspace included.
  if (principal.type !== "user" || !principal.attributes?.workspaceId) return;
  try {
    await wakeProactiveWatch(scopeFromPrincipal(principal));
  } catch (error) {
    // The account is connected either way; the checks come back on their own.
    console.warn("[proactive] could not wake the checks after connect", {
      cause: error,
    });
  }
}

const googleWorkspaceAuth = {
  full: googleWorkspaceProvider("full"),
  read_only: googleWorkspaceProvider("read_only"),
};

/** The Google access level of the workspace this session acts for. */
export async function googleWorkspaceAccess(
  ctx: Pick<SessionContext, "session">
) {
  const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
  if (!caller) {
    throw new Error("Google Workspace requires an authenticated Bro user.");
  }
  return getGoogleWorkspaceAccess(scopeFromPrincipal(caller));
}

/**
 * The person's own Google connected account for this session's level, the
 * sign-in card when there is none. Other tools that act on the same Google
 * connection (Sheets and Docs through `apps`) take it from here.
 */
export async function googleConnectedAccount(ctx: ToolContext) {
  const access = await googleWorkspaceAccess(ctx);
  const provider = googleWorkspaceAuth[access];
  const options = { authKey: googleWorkspaceAuthKeys[access] };
  const { token } = await ctx.getToken(provider, options);
  return {
    connectedAccountId: token,
    requireAuth: () => ctx.requireAuth(provider, options),
  };
}

/**
 * What the model reads when a Google write meets a read-only workspace. The
 * person chose read-only on purpose: the refusal says the action is not
 * available and leaves widening the access to the person.
 */
export const googleReadOnlyWriteRefusal =
  "Не сделано: Google подключён только на чтение, и в этом режиме Бро ничего не отправляет, не сохраняет черновики и не меняет в почте, календаре, контактах и документах. Скажи человеку прямо, что в режиме только чтения это действие недоступно, и сделай то, что можно без записи (например, дай готовый текст, чтобы он отправил сам). Не предлагай и не уговаривай перейти на полный доступ: человек сам выбрал «только чтение». Полный доступ подключай (connect_google с access `full`), только если человек сам об этом попросит.";

/**
 * What the model reads when a Google write would have shown its card while
 * the person has no Google connected. Approving such a card only led to a
 * second one, the sign-in, and a person who had disconnected Google on
 * purpose was asked to confirm an email Bro could not send.
 */
export const googleNotConnectedWriteRefusal =
  "Не сделано и карточку не показываю: Google у человека сейчас не подключён (или отключён), поэтому Бро не может ничего отправить или изменить в почте, календаре и документах. Скажи прямо, что Google не подключён, и не делай вид, что действие выполнено. Вызови connect_google (action `connect`) и отдай ссылку на подключение; после подключения повтори это действие — карточка появится снова. Если человек сам отключил Google, ссылку не навязывай: предложи подключить, когда захочет, и дай готовый текст, чтобы он сделал это сам.";

/**
 * Approval decision for a Google write. A read-only workspace is refused
 * before any prompt, with a reason the model relays; so is a card for a
 * person with no live Google grant, whose approval could run nothing.
 * Otherwise the write asks the person (`user-approval`) or runs
 * (`not-applicable`) as given; a write that runs without a card and meets
 * no grant shows eve's sign-in card instead. When Composio cannot say just
 * now whether the grant is there, the card is shown as before.
 * Tools call it from an inline `approval` arrow: eve stamps a durable
 * descriptor only on callbacks authored inline in `defineTool()`, and a
 * dynamic tool with a returned closure fails to resolve.
 */
export async function googleWriteApproval(
  ctx: Pick<SessionContext, "session">,
  whenWritable: "not-applicable" | "user-approval"
): Promise<ApprovalStatus> {
  const access = await googleWorkspaceAccess(ctx);
  if (access === "read_only") {
    return { reason: googleReadOnlyWriteRefusal, type: "denied" };
  }
  if (whenWritable === "not-applicable") return whenWritable;
  const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
  if (!caller) return whenWritable;
  const connection = await readGoogleWorkspaceConnection(
    scopeFromPrincipal(caller).userId,
    access
  );
  return connection.state === "disconnected"
    ? { reason: googleNotConnectedWriteRefusal, type: "denied" }
    : whenWritable;
}

/**
 * What the model reads when Google keeps refusing for rate or quota. A quota
 * error once came back to the person as «Google не подключён», which sent
 * them to reconnect a working account.
 */
export const googleRateLimitMessage =
  "Google временно ограничил запросы к этому аккаунту (лимит частоты или квоты API). Это не отключение: Google подключён, connect_google не нужен. Не повторяй вызовы Google в этом ходе; ответь тем, что уже есть, и скажи человеку: «Google временно ограничил запросы — напиши мне через минуту, и я попробую снова». Не обещай повторить сам: повтора никто не запланировал.";

/** A Google API call refused for rate or quota even after backing off. */
export class GoogleRateLimitError extends Error {
  override readonly name = "GoogleRateLimitError";

  constructor(options?: ErrorOptions) {
    super(googleRateLimitMessage, options);
  }
}

const reasonsSchema = z
  .array(z.object({ reason: z.string().optional() }))
  .default([]);

const googleErrorBodySchema = z.object({
  error: z.object({
    details: reasonsSchema,
    errors: reasonsSchema,
    message: z.string().optional(),
    status: z.string().optional(),
  }),
});

/** A text body that may hold JSON, such as an error the proxy left unparsed. */
const jsonTextSchema = z.string().transform((text) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return parsed;
});

/**
 * Google's error body as the proxy passes it on: parsed JSON, or text such
 * as an HTML error page, which yields nothing.
 */
const googleErrorSchema = z.union([
  googleErrorBodySchema,
  jsonTextSchema.pipe(googleErrorBodySchema),
]);

type GoogleErrorDetails = z.output<typeof googleErrorBodySchema>["error"];

/** A Google API call Google answered with an error status. */
export class GoogleApiError extends Error {
  override readonly name = "GoogleApiError";
  /** Google's own error, when its body said one. */
  readonly error: GoogleErrorDetails | undefined;
  readonly status: number;

  constructor(status: number, error: GoogleErrorDetails | undefined) {
    super(
      `Google answered ${String(status)}${error?.message ? `: ${error.message}` : "."}`
    );
    this.error = error;
    this.status = status;
  }
}

type GoogleMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

type QueryValue = boolean | number | string | readonly string[] | undefined;

/**
 * An absolute Google API URL with its query string; a list value repeats its
 * parameter, as `metadataHeaders` needs.
 */
export function googleUrl(
  base: string,
  path: string,
  query: Readonly<Record<string, QueryValue>> = {}
) {
  const url = new URL(`${base}${path}`);
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, String(item));
    }
  }
  return url.toString();
}

/**
 * Google's REST APIs for one connected account, called through Composio's
 * proxy. A non-2xx answer throws {@link GoogleApiError}.
 */
export function googleClient(connectedAccountId: string, signal: AbortSignal) {
  async function send(request: {
    readonly body?: object;
    readonly method?: GoogleMethod;
    readonly url: string;
  }) {
    const response = await composioProxy(connectedAccountId, {
      body: request.body,
      method: request.method ?? "GET",
      signal,
      url: request.url,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new GoogleApiError(
        response.status,
        googleErrorSchema.safeParse(response.data).data?.error
      );
    }
    return response;
  }
  return {
    /** A JSON call, its answer checked against `schema`. */
    async json<Schema extends z.ZodType>(
      schema: Schema,
      request: Parameters<typeof send>[0]
    ): Promise<z.output<Schema>> {
      const response = await send(request);
      return schema.parse(response.data ?? {});
    },
    /** A download (Drive media or export) as bytes within `maxBytes`. */
    async download(url: string, maxBytes: number) {
      return proxyBodyBytes(await send({ url }), maxBytes, signal);
    },
  };
}

export type GoogleClient = ReturnType<typeof googleClient>;

/**
 * Waits before each retry of a rate-limited call. Gmail's per-user limit is
 * per second, so a short pause usually clears it; a longer one would only hold
 * the step while the model waits.
 */
const rateLimitBackoffMs = [1_000, 3_000] as const;

/**
 * Runs Google calls for the person behind this tool call. A rejected grant —
 * a 401, a grant without a scope the call needs, an account Composio no
 * longer has — shows the sign-in card again; a rate or quota refusal is
 * retried after a short wait and then reported as such.
 */
export async function withGoogleAuth<T>(
  ctx: ToolContext,
  execute: (client: GoogleClient) => Promise<T>
) {
  const { connectedAccountId, requireAuth } = await googleConnectedAccount(ctx);
  const client = googleClient(connectedAccountId, ctx.abortSignal);

  for (let attempt = 0; ; attempt += 1) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each retry waits for the one before it.
      return await execute(client);
    } catch (error) {
      // A grant from before a scope joined the auth config still works, and
      // Google answers it with 403 rather than 401; both mean the person has
      // to consent again. A read-only workspace never reaches a write call,
      // so its scope 403s are stale grants too.
      if (
        googleApiErrorStatus(error) === 401 ||
        isInsufficientScopeError(error) ||
        isMissingConnectedAccount(error)
      ) {
        requireAuth();
      }
      if (!isGoogleRateLimit(error)) throw error;
      const delay = rateLimitBackoffMs[attempt];
      if (delay === undefined) throw new GoogleRateLimitError({ cause: error });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Backing off is the point.
      await setTimeout(delay, undefined, { signal: ctx.abortSignal });
    }
  }
}

/** The status Google answered a failed call with, or nothing. */
export function googleApiErrorStatus(cause: unknown) {
  return cause instanceof GoogleApiError ? cause.status : undefined;
}

/** The parsed error of a failed Google call, or nothing. */
function googleErrorBody(cause: unknown) {
  return cause instanceof GoogleApiError ? cause.error : undefined;
}

function errorReasons(error: GoogleErrorDetails) {
  return [...error.errors, ...error.details].flatMap(({ reason }) =>
    reason === undefined ? [] : [reason]
  );
}

/** The reasons Google gives a grant that lacks a scope the call needs. */
const insufficientScopeReasons = new Set([
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
  "insufficientPermissions",
]);

/** Whether Google refused the call because the grant lacks a scope. */
function isInsufficientScopeError(cause: unknown) {
  if (googleApiErrorStatus(cause) !== 403) return false;
  const error = googleErrorBody(cause);
  return (
    error !== undefined &&
    errorReasons(error).some((reason) => insufficientScopeReasons.has(reason))
  );
}

/** Reasons Google gives for a refusal that passes once calls slow down. */
const rateLimitReasons = new Set([
  "dailyLimitExceeded",
  "quotaExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

/**
 * Whether the call was refused for rate or quota: Google's 429 and a 403
 * whose reason or message says so, or Composio throttling the proxy itself.
 * Other 403s — a missing scope, a disabled API — are real refusals and are
 * not retried.
 */
export function isGoogleRateLimit(cause: unknown) {
  if (cause instanceof ComposioError) return cause.status === 429;
  const status = googleApiErrorStatus(cause);
  if (status === 429) return true;
  if (status !== 403) return false;
  const error = googleErrorBody(cause);
  if (error === undefined) return false;
  return (
    errorReasons(error).some((reason) => rateLimitReasons.has(reason)) ||
    error.status === "RESOURCE_EXHAUSTED" ||
    /quota|rate limit/iu.test(error.message ?? "")
  );
}
