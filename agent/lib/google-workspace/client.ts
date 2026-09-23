import { auth } from "@googleapis/gmail";
import { connect, type EveAuthorizationOptions } from "@vercel/connect/eve";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { env } from "@shared/environment";
import {
  googleWorkspaceSubject,
  googleWorkspaceScopes,
} from "@shared/google-workspace/connection";

export const googleWorkspaceAuthOptions = {
  connector: env.GOOGLE_CONNECTOR_UID,
  createSubject(principal) {
    if (principal.type !== "user") {
      throw new Error("Google Workspace requires an authenticated Bro user.");
    }
    return googleWorkspaceSubject(principal.id);
  },
  tokenParams: { scopes: [...googleWorkspaceScopes] },
  validate: true,
} satisfies EveAuthorizationOptions;

const googleWorkspaceAuth = connect(googleWorkspaceAuthOptions);

export async function withGoogleAuth<T>(
  ctx: ToolContext,
  execute: (authClient: InstanceType<typeof auth.OAuth2>) => Promise<T>
) {
  const { token } = await ctx.getToken(googleWorkspaceAuth);
  const authClient = new auth.OAuth2();
  authClient.setCredentials({ access_token: token });

  try {
    return await execute(authClient);
  } catch (error) {
    // A grant from before a scope joined `googleWorkspaceScopes` still yields
    // a token, and Google answers it with 403 rather than 401; both mean the
    // person has to consent again.
    if (
      googleApiErrorStatus(error) === 401 ||
      isInsufficientScopeError(error)
    ) {
      ctx.requireAuth(googleWorkspaceAuth);
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
