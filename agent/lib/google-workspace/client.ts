import { auth } from "@googleapis/gmail";
import type {
  ConnectAuthorizationOptions,
  ConnectOptions,
} from "@vercel/connect";
import { connect, type EveAuthorizationOptions } from "@vercel/connect/eve";
import type { SessionContext } from "eve/context";
import type { ToolContext } from "eve/tools";
import type { ApprovalStatus } from "eve/tools/approval";
import { z } from "zod";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
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
 * after authorization completes; it is not awaited and only logs.
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
      return result;
    },
  };
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

  try {
    return await execute(authClient);
  } catch (error) {
    // A grant from before a scope joined `googleWorkspaceScopes` still yields
    // a token, and Google answers it with 403 rather than 401; both mean the
    // person has to consent again. A read-only workspace never reaches a
    // write call, so its 403s are stale grants too.
    if (
      googleApiErrorStatus(error) === 401 ||
      isInsufficientScopeError(error)
    ) {
      ctx.requireAuth(provider, options);
    }
    throw error;
  }
}

const googleApiErrorSchema = z.object({
  response: z.object({ status: z.number() }),
});

export function googleApiErrorStatus(cause: unknown) {
  const result = googleApiErrorSchema.safeParse(cause);
  return result.success ? result.data.response.status : undefined;
}

/** The reasons Google gives a token that lacks a scope the call needs. */
const insufficientScopeReasons = new Set([
  "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
  "insufficientPermissions",
]);

const reasonsSchema = z
  .array(z.object({ reason: z.string().optional() }))
  .default([]);

const googleErrorBodySchema = z.object({
  error: z.object({ details: reasonsSchema, errors: reasonsSchema }),
});

const errorBodySchema = z.object({ response: z.object({ data: z.unknown() }) });

/**
 * The JSON error body of a failed call. A download requested as
 * `arraybuffer` gets its error body as bytes too.
 */
function googleErrorBody(cause: unknown) {
  const data = errorBodySchema.safeParse(cause).data?.response.data;
  const text =
    data instanceof ArrayBuffer
      ? new TextDecoder().decode(data)
      : z.string().safeParse(data).data;
  if (text === undefined) return data;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

/** Whether Google refused the call because the grant lacks a scope. */
function isInsufficientScopeError(cause: unknown) {
  if (googleApiErrorStatus(cause) !== 403) return false;
  const body = googleErrorBodySchema.safeParse(googleErrorBody(cause));
  if (!body.success) return false;
  return [...body.data.error.errors, ...body.data.error.details].some(
    ({ reason }) => reason !== undefined && insufficientScopeReasons.has(reason)
  );
}
