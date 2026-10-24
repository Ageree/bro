import type { TRPCClientErrorLike } from "@trpc/client";
import type { AppRouter } from "@web/trpc/router";

/** Refusals the server words for the person itself. */
const explained = new Set([
  "CONFLICT",
  "FORBIDDEN",
  "NOT_FOUND",
  "TOO_MANY_REQUESTS",
]);

/**
 * What a failed call tells the person: the server's own words for a refusal
 * it explains, a plain retry for anything else, whose message is not theirs
 * to read.
 */
export function broFailure(error: TRPCClientErrorLike<AppRouter>) {
  return explained.has(error.data?.code ?? "")
    ? error.message
    : "Не получилось. Попробуй ещё раз.";
}
