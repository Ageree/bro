import { setTimeout } from "node:timers/promises";
import { auth } from "@googleapis/gmail";
import type {
  ConnectAuthorizationOptions,
  ConnectOptions,
} from "@vercel/connect";
import { connect, type EveAuthorizationOptions } from "@vercel/connect/eve";
import type { ConnectionPrincipal } from "eve/connections";
import type { SessionContext } from "eve/context";
import type { ToolContext } from "eve/tools";
import type { ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { wakeProactiveWatch } from "@db/services/proactive";
import { getGoogleWorkspaceAccess } from "@db/services/settings";
import { env } from "@shared/environment";
import {
  type GoogleWorkspaceAccess,
  googleWorkspaceConsentPrompt,
  googleWorkspaceSubject,
  googleWorkspaceScopes,
  warnWhenGrantCannotRefresh,
} from "@shared/google-workspace/connection";

// The eve adapter spreads `connectOptions` into `startAuthorization`, so the
// consent prompt reaches the chat's sign-in card too; its `getToken` calls
// ignore the field.
const googleWorkspaceConnectOptions: ConnectOptions &
  Pick<ConnectAuthorizationOptions, "prompt"> = {
  prompt: googleWorkspaceConsentPrompt,
};

export function googleWorkspaceAuthOptions(access: GoogleWorkspaceAccess) {
  return {
    connectOptions: googleWorkspaceConnectOptions,
    connector: env.GOOGLE_CONNECTOR_UID,
    createSubject(principal) {
      if (principal.type !== "user") {
        throw new Error("Google Workspace requires an authenticated Bro user.");
      }
      return googleWorkspaceSubject(principal.id);
    },
    tokenParams: { scopes: [...googleWorkspaceScopes[access]] },
    validate: true,
  } satisfies EveAuthorizationOptions;
}

/**
 * The eve provider for one access level. A person who signs in from the
 * chat card never opens the cabinet, so the grant's offline check runs right
 * after authorization completes; it is not awaited and only logs. The same
 * moment wakes Bro's own mail and calendar checks, which a missing grant had
 * put off for hours.
 */
export function googleWorkspaceProvider(access: GoogleWorkspaceAccess) {
  const provider = connect(googleWorkspaceAuthOptions(access));
  return {
    ...provider,
    async completeAuthorization(
      input: Parameters<typeof provider.completeAuthorization>[0]
    ) {
      const result = await provider.completeAuthorization(input);
      void warnWhenGrantCannotRefresh(result.token);
      await wakeProactiveChecks(input.principal);
      return result;
    },
  };
}

async function wakeProactiveChecks(principal: ConnectionPrincipal) {
  // eve hands over the session caller's attributes, its workspace included.
  if (principal.type !== "user" || !principal.attributes?.workspaceId) return;
  try {
    await wakeProactiveWatch(scopeFromPrincipal(principal));
  } catch (error) {
    // The grant is stored either way; the checks come back on their own.
    console.warn("[proactive] could not wake the checks after connect", {
      cause: error,
    });
  }
}

const googleWorkspaceAuth = {
  full: googleWorkspaceProvider("full"),
  read_only: googleWorkspaceProvider("read_only"),
};

// Both providers share one connector, so the read-only one carries its own
// key: a token cached for one scope set is never served for the other.
const googleWorkspaceAuthKeys = {
  full: undefined,
  read_only: "google-workspace-read-only",
} satisfies Record<GoogleWorkspaceAccess, string | undefined>;

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

export const googleReadOnlyWriteRefusal =
  "Google подключён только на чтение: Бро видит почту, календарь и контакты, но ничего не отправляет, не сохраняет черновики и не меняет. Скажи человеку это прямо. Чтобы разрешить действие, он переподключает Google с полным доступом: connect_google с access `full` или кнопка в кабинете.";

/**
 * Approval decision for a Google write. A read-only workspace is refused
 * before any prompt, with a reason the model relays; otherwise the write
 * asks the person (`user-approval`) or runs (`not-applicable`) as given.
 * Tools call it from an inline `approval` arrow: eve stamps a durable
 * descriptor only on callbacks authored inline in `defineTool()`, and a
 * dynamic tool with a returned closure fails to resolve.
 */
export async function googleWriteApproval(
  ctx: Pick<SessionContext, "session">,
  whenWritable: "not-applicable" | "user-approval"
): Promise<ApprovalStatus> {
  return (await googleWorkspaceAccess(ctx)) === "read_only"
    ? { reason: googleReadOnlyWriteRefusal, type: "denied" }
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

/**
 * Waits before each retry of a rate-limited call. Gmail's per-user limit is
 * per second, so a short pause usually clears it; a longer one would only hold
 * the step while the model waits.
 */
const rateLimitBackoffMs = [1_000, 3_000] as const;

export async function withGoogleAuth<T>(
  ctx: ToolContext,
  execute: (authClient: InstanceType<typeof auth.OAuth2>) => Promise<T>
) {
  const access = await googleWorkspaceAccess(ctx);
  const provider = googleWorkspaceAuth[access];
  const authKey = googleWorkspaceAuthKeys[access];
  const options = authKey ? { authKey } : undefined;
  const { token } = await ctx.getToken(provider, options);
  const authClient = new auth.OAuth2();
  authClient.setCredentials({ access_token: token });

  for (let attempt = 0; ; attempt += 1) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each retry waits for the one before it.
      return await execute(authClient);
    } catch (error) {
      // A grant from before a scope joined `googleWorkspaceScopes` still yields
      // a token, and Google answers it with 403 rather than 401; both mean the
      // person has to consent again. A read-only workspace never reaches a
      // write call, so its scope 403s are stale grants too.
      if (
        googleApiErrorStatus(error) === 401 ||
        isInsufficientScopeError(error)
      ) {
        ctx.requireAuth(provider, options);
      }
      if (!isGoogleRateLimit(error)) throw error;
      const delay = rateLimitBackoffMs[attempt];
      if (delay === undefined) throw new GoogleRateLimitError({ cause: error });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Backing off is the point.
      await setTimeout(delay, undefined, { signal: ctx.abortSignal });
    }
  }
}

const googleApiErrorSchema = z.object({
  response: z.object({ status: z.number() }),
});

export function googleApiErrorStatus(cause: unknown) {
  const result = googleApiErrorSchema.safeParse(cause);
  return result.success ? result.data.response.status : undefined;
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

const errorResponseSchema = z.object({
  response: z.object({ data: z.unknown() }),
});

/**
 * The parsed error body of a failed call, or nothing. A download requested as
 * `arraybuffer` gets its error body as bytes too.
 */
function googleErrorBody(cause: unknown) {
  const data = errorResponseSchema.safeParse(cause).data?.response.data;
  const text =
    data instanceof ArrayBuffer
      ? new TextDecoder().decode(data)
      : z.string().safeParse(data).data;
  let body: unknown = data;
  if (text !== undefined) {
    try {
      body = JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  return googleErrorBodySchema.safeParse(body).data?.error;
}

function errorReasons(error: NonNullable<ReturnType<typeof googleErrorBody>>) {
  return [...error.errors, ...error.details].flatMap(({ reason }) =>
    reason === undefined ? [] : [reason]
  );
}

/** The reasons Google gives a token that lacks a scope the call needs. */
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
 * Whether Google refused for rate or quota: always a 429, and a 403 whose
 * reason or message says so. Other 403s — a missing scope, a disabled API —
 * are real refusals and are not retried.
 */
export function isGoogleRateLimit(cause: unknown) {
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
