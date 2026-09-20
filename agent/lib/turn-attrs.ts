/** Reading the turn's own auth attributes: the only place a tool learns
 *  which conversation it is in without trusting a model argument. */

type AuthBox = {
  session?: {
    auth?: {
      current?: {
        principalId?: string | null;
        attributes?: Record<string, unknown>;
      } | null;
      initiator?: {
        principalId?: string | null;
        attributes?: Record<string, unknown>;
      } | null;
    };
  };
};

export function turnAttributes(
  ctx: AuthBox,
): Record<string, unknown> | undefined {
  return (
    ctx.session?.auth?.current?.attributes ??
    ctx.session?.auth?.initiator?.attributes
  );
}

/** A single turn attribute, unwrapping array-valued attributes to their first entry. */
export function attr(ctx: AuthBox, key: string): string | undefined {
  const raw = turnAttributes(ctx)?.[key];
  const id = Array.isArray(raw) ? raw[0] : raw;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function conversationId(ctx: AuthBox, fallback?: string): string | undefined {
  const fromAuth = turnAttributes(ctx)?.conversationId;
  return typeof fromAuth === "string" && fromAuth.length > 0 ? fromAuth : fallback;
}
