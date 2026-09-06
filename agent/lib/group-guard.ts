import { groupPrivateOnlyText, isGroupAuthFlag } from "../../convex/lib/groupChatPolicy.ts";

type AuthBox = {
  session: {
    auth: {
      current?: { attributes?: Record<string, unknown> } | null;
      initiator?: { attributes?: Record<string, unknown> } | null;
    };
  };
};

export function turnAttributes(
  ctx: AuthBox,
): Record<string, unknown> | undefined {
  return (
    ctx.session.auth.current?.attributes ??
    ctx.session.auth.initiator?.attributes
  );
}

export function isGroupTurn(ctx: AuthBox): boolean {
  return isGroupAuthFlag(turnAttributes(ctx));
}

/** Personal errands stay in the 1:1 thread. */
export function groupPersonalBlock(ctx: AuthBox): string | undefined {
  if (!isGroupTurn(ctx)) return undefined;
  return groupPrivateOnlyText();
}
