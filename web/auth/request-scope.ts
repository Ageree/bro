import { headers } from "next/headers";
import { cache } from "react";
import { getAuthSession } from "@db/services/auth/session";
import {
  accessScopeForUser,
  type AccessScope,
} from "@shared/identity/access-scope";

/**
 * The signed-in session of this request, read once: the root layout, the
 * cabinet layout and the page each ask, and every Better Auth read is two
 * queries (the session row, then its user).
 */
export const requestSession = cache(async () =>
  getAuthSession(await headers())
);

export const requireRequestScope = cache(async (): Promise<AccessScope> => {
  const session = await requestSession();
  if (!session) throw new UnauthenticatedError();
  return accessScopeForUser(`better-auth:${session.user.id}`);
});

export class UnauthenticatedError extends Error {
  constructor() {
    super("Sign in to continue.");
    this.name = "UnauthenticatedError";
  }
}
