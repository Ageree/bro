import { isConnectionAuthorizationRequiredError } from "eve/connections";

/**
 * Whether a tool call stopped on a sign-in: eve's `getToken` and
 * `requireAuth` throw an error the tool runner turns into the sign-in card,
 * which parks the whole turn until the person connects. eve wraps the
 * provider's own error (`ScopedAuthorizationRequiredError`, the provider's
 * as its cause).
 */
export function signInRequired(cause: unknown) {
  return (
    cause instanceof Error &&
    (cause.name === "ScopedAuthorizationRequiredError" ||
      isConnectionAuthorizationRequiredError(cause) ||
      isConnectionAuthorizationRequiredError(cause.cause))
  );
}
