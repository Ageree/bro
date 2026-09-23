import { auth } from "@googleapis/gmail";
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
  googleWorkspaceSubject,
  googleWorkspaceScopes,
} from "@shared/google-workspace/connection";

export function googleWorkspaceAuthOptions(access: GoogleWorkspaceAccess) {
  return {
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

const googleWorkspaceAuth = {
  full: connect(googleWorkspaceAuthOptions("full")),
  read_only: connect(googleWorkspaceAuthOptions("read_only")),
};

// Both providers share one connector, so the read-only one carries its own
// key: a token cached for one scope set is never served for the other.
const googleWorkspaceAuthKeys = {
  full: undefined,
  read_only: "google-workspace-read-only",
} satisfies Record<GoogleWorkspaceAccess, string | undefined>;

/** The Google access level of the workspace this session acts for. */
async function googleWorkspaceAccess(ctx: Pick<SessionContext, "session">) {
  const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
  if (!caller) {
    throw new Error("Google Workspace requires an authenticated Bro user.");
  }
  return getGoogleWorkspaceAccess(scopeFromPrincipal(caller));
}

export const googleReadOnlyWriteRefusal =
  "Google подключён только на чтение: Бро видит почту, календарь и контакты, но ничего не отправляет, не сохраняет черновики и не меняет. Скажи человеку это прямо. Чтобы разрешить действие, он переподключает Google с полным доступом: connect_google с access `full` или кнопка в кабинете.";

/**
 * Approval policy for a Google write. A read-only workspace is refused
 * before any prompt, with a reason the model relays; otherwise the write
 * asks the person (`user-approval`) or runs (`not-applicable`) as given.
 */
export function googleWriteApproval(
  whenWritable: "not-applicable" | "user-approval"
) {
  return async (
    ctx: Pick<SessionContext, "session">
  ): Promise<ApprovalStatus> =>
    (await googleWorkspaceAccess(ctx)) === "read_only"
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
    if (googleApiErrorStatus(error) === 401) {
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
